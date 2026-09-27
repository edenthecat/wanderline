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
  // Per-choice indicator sounds. story-data-builder has read
  // settings.choiceIndicatorAudio.{choice1FileId,choice2FileId} and the
  // player has honoured them for a while, but the key was never on this
  // list, so any attempt to set it was silently dropped here and the
  // feature was unreachable outside a direct DB edit.
  'choiceIndicatorAudio',
  'choiceAudioDelayMs',
  'captionsDefault',
  // Project-wide default for advancing to the next passage on its own
  // once narration ends. Off unless the author turns it on; a node can
  // still override either way.
  'autoAdvance',
  'showProgressBar',
  'showChoiceList',
  'bluetoothControls',
  'theme',
  // vocab-skin preference. Silently dropping this would have
  // made the Settings > Nomenclature radio a no-op.
  'nomenclature',
  // Author-supplied README for the exported build. Empty / absent
  // falls back to the default template in build-readme.ts.
  'exportReadme',
  // BCP-47 tag for the story's own language. Written into <html lang>
  // and the manifest of every generated build so a screen reader reads
  // the captions with the right voice. Absent / malformed falls back
  // to 'en' at build time (see build-language.ts).
  'language',
  // PWA identity for the generated player: { fileId, backgroundColor,
  // themeColor }. Nested-merged so setting a colour doesn't drop the
  // uploaded icon.
  'appIcon',
]);

// Nested objects that get merged key-by-key with the existing stored
// value rather than replaced wholesale. A partial patch like
// { bluetoothControls: { nextTrack: 'confirm' } } previously wiped
// previousTrack via the `||` shallow merge.
const NESTED_MERGE_KEYS = new Set([
  'bluetoothControls',
  'theme',
  'choiceIndicatorAudio',
  'appIcon',
]);

// Value-level guards for keys whose stored *type and range* matter to
// more than one reader. The allow-list above only decides whether a key
// survives; these decide whether its value is one the rest of the system
// can actually render. Returning undefined drops the key from the patch
// rather than storing something no consumer can use.
//
// The editor's own controls can't produce a bad value here, but this
// endpoint is the contract: a script, a migration or a future feature
// patching settings directly goes through the same door.
// setTimeout takes a signed 32-bit millisecond count; a delay above this
// clamps to 1ms internally in Node/browsers and effectively fires right
// away instead of waiting longer. Both readers of choiceAudioDelayMs
// (player-app/src/App.tsx) drive it through setTimeout, so a value past
// this point wouldn't lengthen the pause — it would silently erase it,
// the opposite of what a project storing such a value intends. This is
// the actual limit the readers share, not a product opinion about pacing
// — see the "no ceiling" note below.
const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;

const VALUE_GUARDS = new Map<string, (value: unknown) => unknown>([
  [
    // Milliseconds of silence before a choice option's audio starts.
    // The player awaits this as a timer and the editor renders it on a
    // slider with a floor of 0, so a negative is meaningless to both —
    // and used to leave the slider (clamped by the native control) and
    // the number printed beside it disagreeing. A non-number is worse:
    // the player's delay would resolve immediately and the editor would
    // print "NaNs". Enforced here so neither reader has to guess.
    //
    // No *product* ceiling on purpose — the player just waits this long,
    // so a pacing opinion belongs to the author, not this endpoint — but
    // it is still capped at MAX_SET_TIMEOUT_DELAY_MS, since past that the
    // readers' own timer mechanism can't represent the value at all.
    'choiceAudioDelayMs',
    (value) =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(0, value), MAX_SET_TIMEOUT_DELAY_MS)
        : undefined,
  ],
]);

// Exported for tests: this function is where the settings contract
// lives — which keys survive, which merge nested rather than replacing,
// and which have their value range enforced — and every part of it is
// easy to break silently.
export function mergeSettingsObject(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) continue;
    const guard = VALUE_GUARDS.get(key);
    if (guard) {
      const guarded = guard(value);
      if (guarded === undefined) continue;
      merged[key] = guarded;
      continue;
    }
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
   *       indicatorVolume, choiceAudioDelayMs, language).
   *       `bluetoothControls` merges key-by-key with the stored value
   *       so partial patches don't wipe sibling keys.
   *       `choiceAudioDelayMs` must be a finite number and is clamped to
   *       [0, 2147483647] (the largest delay setTimeout can represent);
   *       anything else is dropped.
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
