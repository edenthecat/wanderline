import { Router, Request, Response } from 'express';
import { Pool, PoolClient } from 'pg';

// Top-level settings keys the PATCH endpoint accepts. Unknown keys are
// dropped — the editor only sends these, and an unrecognized key is
// more likely a typo than a feature we haven't wired up yet. Mirrors
// the ProjectSettings shape in frontend/src/api/client.ts.
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'password',
  'voiceoverVolume',
  'backgroundMusicEnabled',
  'backgroundMusicVolume',
  'indicatorVolume',
  'defaultIndicatorAudioId',
  'choiceAudioDelayMs',
  'captionsDefault',
  'showProgressBar',
  'showChoiceList',
  'bluetoothControls',
  'theme',
  // vocab-skin preference. Silently dropping this would have
  // made the Settings > Nomenclature radio a no-op.
  'nomenclature',
]);

// Nested objects that get merged key-by-key with the existing stored
// value rather than replaced wholesale. A partial patch like
// { bluetoothControls: { nextTrack: 'confirm' } } previously wiped
// previousTrack via the `||` shallow merge.
const NESTED_MERGE_KEYS = new Set(['bluetoothControls', 'theme']);

function mergeSettingsObject(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) continue;
    if (NESTED_MERGE_KEYS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const existingNested =
        existing[key] && typeof existing[key] === 'object' && !Array.isArray(existing[key])
          ? (existing[key] as Record<string, unknown>)
          : {};
      merged[key] = { ...existingNested, ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Atomically merge a settings patch onto the stored JSONB. The
 * SELECT+UPDATE used to run in two separate pool queries — under
 * concurrent PATCHes that lost updates (last writer overwrote a
 * stale-read merge). Now we run it inside a transaction with the
 * row locked via `SELECT … FOR UPDATE`, so two concurrent PATCH
 * requests serialise rather than race.
 */
async function mergeSettings(
  pool: Pool,
  projectId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query(
      'SELECT settings FROM project_settings WHERE project_id = $1 FOR UPDATE',
      [projectId],
    );
    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const existing: Record<string, unknown> = existingResult.rows[0].settings ?? {};
    const merged = mergeSettingsObject(existing, patch);
    const updateResult = await client.query(
      'UPDATE project_settings SET settings = $1::jsonb WHERE project_id = $2 RETURNING settings',
      [JSON.stringify(merged), projectId],
    );
    await client.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [
      projectId,
    ]);
    await client.query('COMMIT');
    return updateResult.rows[0].settings as Record<string, unknown>;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function mountSettingsRoutes(router: Router, pool: Pool): void {
  /**
   * @openapi
   * /projects/{id}/settings:
   *   get:
   *     summary: Get project settings JSONB.
   *     tags: [Settings]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Project settings.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 settings: { type: object }
   *       404: { description: Settings row not found. }
   */
  router.get('/:id/settings', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `
        SELECT settings FROM project_settings WHERE project_id = $1
      `,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Settings not found' });
        return;
      }

      res.json({ settings: result.rows[0].settings });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get settings');
      res.status(500).json({ error: 'Failed to get settings' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/settings:
   *   patch:
   *     summary: Merge a partial settings patch.
   *     description: |
   *       Whitelists top-level keys (password, captionsDefault,
   *       showProgressBar, showChoiceList, bluetoothControls,
   *       backgroundMusicEnabled, backgroundMusicVolume,
   *       indicatorVolume, choiceAudioDelayMs). `bluetoothControls`
   *       merges key-by-key with the stored value so partial patches
   *       don't wipe sibling keys.
   *     tags: [Settings]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               settings: { type: object }
   *     responses:
   *       200:
   *         description: Merged settings.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 settings: { type: object }
   *       400: { description: settings payload missing / not an object. }
   *       404: { description: Settings row not found. }
   */
  router.patch('/:id/settings', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { settings } = req.body;

      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        res.status(400).json({ error: 'Settings must be a plain object' });
        return;
      }

      // mergeSettings now performs the SELECT+UPDATE inside a
      // single transaction with the row locked, so the project
      // timestamp bump and the settings write happen atomically.
      const merged = await mergeSettings(pool, id, settings);
      if (merged === null) {
        res.status(404).json({ error: 'Settings not found' });
        return;
      }

      res.json({ settings: merged });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update settings');
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });
}
