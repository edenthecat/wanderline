import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { parseInk } from '../services/ink-parser.js';
import { parseInkJson } from '../services/ink-json-parser.js';
import { parseTwee, TweeParseError } from '../services/twee-parser.js';
import { emitTwee } from '../services/twee-emitter.js';
import { emitInk } from '../services/ink-converter.js';
import { randomUUID } from 'crypto';
import { captureSnapshot } from './projects-snapshots.js';
import { invalidateRoom } from '../services/collab-server.js';

export function mountStoryRoutes(router: Router, pool: Pool): void {
  /**
   * @openapi
   * /projects/{id}/ink:
   *   post:
   *     summary: Upload an Ink source string for a project.
   *     description: |
   *       Parses the Ink and stores both the source and the rendered
   *       story_graph (with validation errors / warnings) on the
   *       `project_stories` row.
   *     tags: [Story]
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
   *             required: [source]
   *             properties:
   *               source: { type: string }
   *     responses:
   *       200:
   *         description: Parsed + persisted.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *                 story: { type: object }
   *       400: { description: Empty source or parser failure. }
   */
  router.post('/:id/ink', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Check project exists
      const projectCheck = await pool.query('SELECT id FROM projects WHERE id = $1', [id]);
      if (projectCheck.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      let source: string;
      if (typeof req.body === 'string') {
        source = req.body;
      } else if (req.body && typeof req.body.source === 'string') {
        source = req.body.source;
      } else {
        res.status(400).json({ error: 'Ink source is required' });
        return;
      }

      if (!source.trim()) {
        res.status(400).json({ error: 'Ink source cannot be empty' });
        return;
      }

      const storyId = randomUUID();
      const storyGraph = parseInk(source, storyId);

      // Auto-capture the previous state before we overwrite it.
      // Skipped if the project has no story yet (first-time upload).
      const existing = await pool.query('SELECT 1 FROM project_stories WHERE project_id = $1', [
        id,
      ]);
      if (existing.rows.length > 0) {
        try {
          await captureSnapshot({
            pool,
            projectId: id,
            label: 'Before ink upload',
            source: 'auto',
            createdBy: req.session?.userId ?? null,
          });
        } catch (snapErr) {
          // Don't let a snapshot failure block an upload — log it
          // and continue. The user can still proceed; they just
          // won't have an automatic rollback point for this upload.
          req.log.warn({ err: snapErr }, 'Pre-upload snapshot capture failed');
        }
      }

      // an Ink upload sets source_language='ink' and clears
      // twee_source (the previous authoritative-in-Twee text is now
      // out of date; regenerated on demand from story_graph if the
      // user exports Twee later).
      await pool.query(
        `
        INSERT INTO project_stories
          (project_id, story_graph, ink_source, source_language, twee_source)
        VALUES ($1, $2, $3, 'ink', NULL)
        ON CONFLICT (project_id)
        DO UPDATE SET
          story_graph = $2,
          ink_source = $3,
          source_language = 'ink',
          twee_source = NULL,
          updated_at = CURRENT_TIMESTAMP
      `,
        [id, JSON.stringify(storyGraph), source],
      );

      // Update project's updated_at
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      // Drop any live collab room so connected editors reconnect
      // against the just-uploaded ink instead of editing the stale
      // in-memory Y.Doc. Awaited so any in-flight shadow-save
      // settles BEFORE we tell clients to reconnect — without the
      // await a trailing UPDATE could land after this handler and
      // revert our row.
      await invalidateRoom(id);

      res.json({
        success: true,
        story: storyGraph,
        summary: {
          nodeCount: Object.keys(storyGraph.nodes).length,
          knotCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'knot').length,
          stitchCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'stitch').length,
          errorCount: storyGraph.validation.errors.length,
          warningCount: storyGraph.validation.warnings.length,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to upload ink');
      res.status(500).json({ error: 'Failed to upload ink file' });
    }
  });

  // Upload compiled Ink JSON
  /**
   * @openapi
   * /projects/{id}/ink-json:
   *   post:
   *     summary: Upload pre-compiled Ink JSON.
   *     description: |
   *       Same effect as POST /ink but skips the parser — accepts the
   *       output of Inkle's compiler directly. Useful for round-tripping
   *       through the Inky desktop tool.
   *     tags: [Story]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       description: |
   *         Three accepted shapes — the handler accepts any of them:
   *         1. The raw compiled JSON as the body (must have `inkVersion`).
   *         2. `{ "source": "<stringified Ink JSON>" }`.
   *         3. The Ink JSON envelope sent as a JSON string body.
   *       content:
   *         application/json:
   *           schema:
   *             oneOf:
   *               - type: object
   *                 required: [inkVersion]
   *                 properties:
   *                   inkVersion: { type: integer }
   *                 additionalProperties: true
   *               - type: object
   *                 required: [source]
   *                 properties:
   *                   source:
   *                     type: string
   *                     description: Stringified compiled Ink JSON.
   *         text/plain:
   *           schema:
   *             type: string
   *             description: Compiled Ink JSON as a raw string body.
   *     responses:
   *       200:
   *         description: Parsed + persisted.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *                 story: { type: object }
   *       400: { description: Missing or invalid JSON shape. }
   */
  router.post('/:id/ink-json', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Check project exists
      const projectCheck = await pool.query('SELECT id FROM projects WHERE id = $1', [id]);
      if (projectCheck.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      let jsonContent: string;
      if (typeof req.body === 'string') {
        jsonContent = req.body;
      } else if (req.body && req.body.inkVersion) {
        // Direct JSON object
        jsonContent = JSON.stringify(req.body);
      } else if (req.body && typeof req.body.source === 'string') {
        jsonContent = req.body.source;
      } else {
        res.status(400).json({ error: 'Compiled Ink JSON is required' });
        return;
      }

      const storyId = randomUUID();
      const storyGraph = parseInkJson(jsonContent, storyId);

      // compiled Ink JSON has no editable source, but
      // authoring is still Ink-flavoured — set source_language='ink'
      // and clear twee_source so the vocab + editor pick the Ink
      // side.
      await pool.query(
        `
        INSERT INTO project_stories
          (project_id, story_graph, ink_source, source_language, twee_source)
        VALUES ($1, $2, NULL, 'ink', NULL)
        ON CONFLICT (project_id)
        DO UPDATE SET
          story_graph = $2,
          ink_source = NULL,
          source_language = 'ink',
          twee_source = NULL,
          updated_at = CURRENT_TIMESTAMP
      `,
        [id, JSON.stringify(storyGraph)],
      );

      // Update project's updated_at
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      res.json({
        success: true,
        story: storyGraph,
        summary: {
          nodeCount: Object.keys(storyGraph.nodes).length,
          knotCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'knot').length,
          stitchCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'stitch').length,
          errorCount: storyGraph.validation.errors.length,
          warningCount: storyGraph.validation.warnings.length,
        },
      });
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.status(400).json({ error: 'Invalid JSON: ' + error.message });
        return;
      }
      req.log.error({ err: error }, 'Failed to upload ink json');
      res.status(500).json({ error: 'Failed to upload ink json file' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/twine:
   *   post:
   *     summary: Upload a Twee 3 source string for a project.
   *     description: |
   *       Parses Twee 3 source into the same StoryGraph
   *       shape the Ink parser produces, then persists both the
   *       source and the rendered graph on `project_stories`.
   *       Sets `source_language='twee'` and clears any previous
   *       `ink_source` (regenerated on demand via the Ink emitter
   *       if the user later exports).
   *
   *       Twee 1 files (`!Passage` header shape) are rejected with
   *       400 and a message asking the user to re-export as Twee 3.
   *     tags: [Story]
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
   *               source: { type: string }
   *         text/plain:
   *           schema: { type: string }
   *     responses:
   *       200:
   *         description: Parsed + persisted.
   *       400: { description: 'Empty source, Twee 1 shape, or parse failure.' }
   *       404: { description: Project not found. }
   */
  router.post('/:id/twine', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const projectCheck = await pool.query('SELECT id FROM projects WHERE id = $1', [id]);
      if (projectCheck.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      let source: string;
      if (typeof req.body === 'string') {
        source = req.body;
      } else if (req.body && typeof req.body.source === 'string') {
        source = req.body.source;
      } else {
        res.status(400).json({ error: 'Twee source is required' });
        return;
      }

      if (!source.trim()) {
        res.status(400).json({ error: 'Twee source cannot be empty' });
        return;
      }

      const storyId = randomUUID();
      let storyGraph;
      try {
        storyGraph = parseTwee(source, { storyId });
      } catch (err) {
        if (err instanceof TweeParseError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }

      // mirror the /ink route's auto-snapshot behaviour so
      // switching between formats leaves a rollback point.
      const existing = await pool.query('SELECT 1 FROM project_stories WHERE project_id = $1', [
        id,
      ]);
      if (existing.rows.length > 0) {
        try {
          await captureSnapshot({
            pool,
            projectId: id,
            label: 'Before twee upload',
            source: 'auto',
            createdBy: req.session?.userId ?? null,
          });
        } catch (snapErr) {
          req.log.warn({ err: snapErr }, 'Pre-upload snapshot capture failed');
        }
      }

      // a Twee upload flips authoritative source to Twee
      // and clears ink_source (regenerated on demand from
      // story_graph if the user later exports Ink).
      await pool.query(
        `
        INSERT INTO project_stories
          (project_id, story_graph, twee_source, source_language, ink_source)
        VALUES ($1, $2, $3, 'twee', NULL)
        ON CONFLICT (project_id)
        DO UPDATE SET
          story_graph = $2,
          twee_source = $3,
          source_language = 'twee',
          ink_source = NULL,
          updated_at = CURRENT_TIMESTAMP
      `,
        [id, JSON.stringify(storyGraph), source],
      );

      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      await invalidateRoom(id);

      res.json({
        success: true,
        story: storyGraph,
        summary: {
          nodeCount: Object.keys(storyGraph.nodes).length,
          knotCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'knot').length,
          stitchCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'stitch').length,
          errorCount: storyGraph.validation.errors.length,
          warningCount: storyGraph.validation.warnings.length,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to upload twee');
      res.status(500).json({ error: 'Failed to upload twee file' });
    }
  });

  // Update choice target in story graph
  router.patch('/:id/story/choice', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, choiceIndex, newTarget } = req.body;

      if (!nodeId || choiceIndex === undefined || !newTarget) {
        res.status(400).json({ error: 'nodeId, choiceIndex, and newTarget are required' });
        return;
      }

      if (
        typeof nodeId !== 'string' ||
        typeof newTarget !== 'string' ||
        !Number.isInteger(choiceIndex) ||
        choiceIndex < 0
      ) {
        res.status(400).json({
          error: 'nodeId and newTarget must be strings, choiceIndex must be a non-negative integer',
        });
        return;
      }

      // Get current story graph
      const storyResult = await pool.query(
        `
        SELECT story_graph FROM project_stories WHERE project_id = $1
      `,
        [id],
      );

      if (storyResult.rows.length === 0 || !storyResult.rows[0].story_graph) {
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph;

      // Validate node exists
      if (!Object.hasOwn(storyGraph.nodes, nodeId)) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      // Validate choice exists
      const node = storyGraph.nodes[nodeId];
      if (!node.choices || choiceIndex >= node.choices.length) {
        res.status(400).json({ error: 'Choice index out of range' });
        return;
      }

      // Validate target exists (unless it's END or DONE)
      if (
        newTarget !== 'END' &&
        newTarget !== 'DONE' &&
        !Object.hasOwn(storyGraph.nodes, newTarget)
      ) {
        res.status(400).json({ error: 'Target node not found' });
        return;
      }

      // Update the choice target
      storyGraph.nodes[nodeId].choices[choiceIndex].target = newTarget;

      // Save updated story graph
      await pool.query(
        `
        UPDATE project_stories
        SET story_graph = $1, updated_at = CURRENT_TIMESTAMP,
            ink_source = NULL, twee_source = NULL
        WHERE project_id = $2
      `,
        [JSON.stringify(storyGraph), id],
      );

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      // The shadow-saver writes the ENTIRE nodes JSONB key from the
      // Y.Doc's view; it doesn't merge per-field. The Y.Doc still
      // has the old target on this choice's Y.Map, so any subsequent
      // Y.Text edit anywhere would trigger a shadow-save that flushes
      // the stale target back over us. Drop the room.
      await invalidateRoom(id);

      res.json({
        success: true,
        story_graph: storyGraph,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update choice target');
      res.status(500).json({ error: 'Failed to update choice target' });
    }
  });

  // Update choice text in story graph
  router.patch('/:id/story/choice/text', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, choiceIndex, newText } = req.body;

      if (!nodeId || choiceIndex === undefined || newText === undefined) {
        res.status(400).json({ error: 'nodeId, choiceIndex, and newText are required' });
        return;
      }

      if (
        typeof nodeId !== 'string' ||
        typeof newText !== 'string' ||
        !Number.isInteger(choiceIndex) ||
        choiceIndex < 0
      ) {
        res.status(400).json({
          error: 'nodeId and newText must be strings, choiceIndex must be a non-negative integer',
        });
        return;
      }

      // Get current story graph
      const storyResult = await pool.query(
        `
        SELECT story_graph FROM project_stories WHERE project_id = $1
      `,
        [id],
      );

      if (storyResult.rows.length === 0 || !storyResult.rows[0].story_graph) {
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph;

      // Validate node exists
      if (!Object.hasOwn(storyGraph.nodes, nodeId)) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      // Validate choice exists
      const node = storyGraph.nodes[nodeId];
      if (!node.choices || choiceIndex >= node.choices.length) {
        res.status(400).json({ error: 'Choice index out of range' });
        return;
      }

      // Update the choice text
      storyGraph.nodes[nodeId].choices[choiceIndex].text = newText;

      // Save updated story graph
      await pool.query(
        `
        UPDATE project_stories
        SET story_graph = $1, updated_at = CURRENT_TIMESTAMP,
            ink_source = NULL, twee_source = NULL
        WHERE project_id = $2
      `,
        [JSON.stringify(storyGraph), id],
      );

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      res.json({
        success: true,
        story_graph: storyGraph,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update choice text');
      res.status(500).json({ error: 'Failed to update choice text' });
    }
  });

  // Update node content text in story graph. The body content of a
  // knot/stitch is the narrator text the player reads — each line is
  // a content[i] with its own text + tags. Editing here is text-only;
  // adding / removing lines goes through a future structural endpoint
  // (today authors do that via the ink-source editor).
  //
  // We intentionally DON'T invalidateRoom here, mirroring the
  // existing /story/choice/text behaviour. The Y.Doc's content-line
  // Y.Text receives the same edit via the collab broadcast in the
  // happy path; the shadow-saver then flushes the matching value
  // back. The narrow window where this can desync is an offline
  // REST PATCH from a peer in fallback mode while another peer's
  // Y.Doc is live — the live doc's next shadow-save would revert
  // the offline change. If we see that in practice, invalidate here
  // (and on /choice/text) to make the room reseed against the
  // freshly-persisted text.
  /**
   * @openapi
   * /projects/{id}/story/node/content/text:
   *   patch:
   *     summary: Replace one node-content line's text.
   *     tags: [Story]
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
   *             required: [nodeId, contentIndex, newText]
   *             properties:
   *               nodeId: { type: string }
   *               contentIndex: { type: integer, minimum: 0 }
   *               newText: { type: string }
   *     responses:
   *       200: { description: Saved. }
   *       400: { description: Bad input. }
   *       404: { description: Node / story not found. }
   */
  router.patch('/:id/story/node/content/text', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, contentIndex, newText } = req.body;

      if (!nodeId || contentIndex === undefined || newText === undefined) {
        res.status(400).json({ error: 'nodeId, contentIndex, and newText are required' });
        return;
      }
      if (
        typeof nodeId !== 'string' ||
        typeof newText !== 'string' ||
        !Number.isInteger(contentIndex) ||
        contentIndex < 0
      ) {
        res.status(400).json({
          error: 'nodeId and newText must be strings, contentIndex must be a non-negative integer',
        });
        return;
      }

      const storyResult = await pool.query(
        `SELECT story_graph FROM project_stories WHERE project_id = $1`,
        [id],
      );
      if (storyResult.rows.length === 0 || !storyResult.rows[0].story_graph) {
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph;
      const node = storyGraph.nodes[nodeId];
      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      if (!node.content || contentIndex >= node.content.length) {
        res.status(400).json({ error: 'Content index out of range' });
        return;
      }

      node.content[contentIndex].text = newText;

      await pool.query(
        `UPDATE project_stories
         SET story_graph = $1, updated_at = CURRENT_TIMESTAMP,
             ink_source = NULL, twee_source = NULL
         WHERE project_id = $2`,
        [JSON.stringify(storyGraph), id],
      );
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      res.json({ success: true, story_graph: storyGraph });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update node content text');
      res.status(500).json({ error: 'Failed to update node content text' });
    }
  });

  // Remove choice from story graph
  router.delete('/:id/story/choice', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, choiceIndex } = req.body;

      if (!nodeId || choiceIndex === undefined) {
        res.status(400).json({ error: 'nodeId and choiceIndex are required' });
        return;
      }

      if (typeof nodeId !== 'string' || !Number.isInteger(choiceIndex) || choiceIndex < 0) {
        res
          .status(400)
          .json({ error: 'nodeId must be a string, choiceIndex must be a non-negative integer' });
        return;
      }

      // Get current story graph
      const storyResult = await pool.query(
        `
        SELECT story_graph FROM project_stories WHERE project_id = $1
      `,
        [id],
      );

      if (storyResult.rows.length === 0 || !storyResult.rows[0].story_graph) {
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph;

      // Validate node exists
      if (!Object.hasOwn(storyGraph.nodes, nodeId)) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      // Validate choice exists
      const node = storyGraph.nodes[nodeId];
      if (!node.choices || choiceIndex >= node.choices.length) {
        res.status(400).json({ error: 'Choice index out of range' });
        return;
      }

      // Remove the choice
      storyGraph.nodes[nodeId].choices.splice(choiceIndex, 1);

      // Save updated story graph
      await pool.query(
        `
        UPDATE project_stories
        SET story_graph = $1, updated_at = CURRENT_TIMESTAMP,
            ink_source = NULL, twee_source = NULL
        WHERE project_id = $2
      `,
        [JSON.stringify(storyGraph), id],
      );

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      // Structural change to the choices array — the in-memory
      // Y.Doc still has the pre-delete `choices` Y.Array, and its
      // next shadow-save would flush the stale index back over our
      // delete. Drop the room so connected clients reconnect against
      // the freshly-written story_graph.
      await invalidateRoom(id);

      res.json({
        success: true,
        story_graph: storyGraph,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to remove choice');
      res.status(500).json({ error: 'Failed to remove choice' });
    }
  });

  // Swap choice order in story graph
  router.patch('/:id/story/choice/swap', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, fromIndex, toIndex } = req.body;

      if (!nodeId || fromIndex === undefined || toIndex === undefined) {
        res.status(400).json({ error: 'nodeId, fromIndex, and toIndex are required' });
        return;
      }

      if (
        typeof nodeId !== 'string' ||
        !Number.isInteger(fromIndex) ||
        !Number.isInteger(toIndex) ||
        fromIndex < 0 ||
        toIndex < 0
      ) {
        res.status(400).json({
          error: 'nodeId must be a string, fromIndex and toIndex must be non-negative integers',
        });
        return;
      }

      // Get current story graph
      const storyResult = await pool.query(
        `
        SELECT story_graph FROM project_stories WHERE project_id = $1
      `,
        [id],
      );

      if (storyResult.rows.length === 0 || !storyResult.rows[0].story_graph) {
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph;

      // Validate node exists
      if (!Object.hasOwn(storyGraph.nodes, nodeId)) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      // Validate indices
      const node = storyGraph.nodes[nodeId];
      if (
        !node.choices ||
        fromIndex >= node.choices.length ||
        toIndex >= node.choices.length ||
        fromIndex < 0 ||
        toIndex < 0
      ) {
        res.status(400).json({ error: 'Choice index out of range' });
        return;
      }

      // Swap the choices
      const temp = storyGraph.nodes[nodeId].choices[fromIndex];
      storyGraph.nodes[nodeId].choices[fromIndex] = storyGraph.nodes[nodeId].choices[toIndex];
      storyGraph.nodes[nodeId].choices[toIndex] = temp;

      // Save updated story graph
      await pool.query(
        `
        UPDATE project_stories
        SET story_graph = $1, updated_at = CURRENT_TIMESTAMP,
            ink_source = NULL, twee_source = NULL
        WHERE project_id = $2
      `,
        [JSON.stringify(storyGraph), id],
      );

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      // Structural change to the choices array — drop the live room
      // so the Y.Doc reseeds against the new order instead of
      // flushing its stale ordering back over us.
      await invalidateRoom(id);

      res.json({
        success: true,
        story_graph: storyGraph,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to swap choices');
      res.status(500).json({ error: 'Failed to swap choices' });
    }
  });

  // Restore/add choice to story graph
  router.post('/:id/story/choice', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, choice, atIndex } = req.body;

      if (!nodeId || !choice || !choice.text || !choice.target) {
        res.status(400).json({ error: 'nodeId, choice.text, and choice.target are required' });
        return;
      }

      if (
        typeof nodeId !== 'string' ||
        typeof choice.text !== 'string' ||
        typeof choice.target !== 'string'
      ) {
        res.status(400).json({ error: 'nodeId, choice.text, and choice.target must be strings' });
        return;
      }

      if (atIndex !== undefined && (!Number.isInteger(atIndex) || atIndex < 0)) {
        res.status(400).json({ error: 'atIndex must be a non-negative integer' });
        return;
      }

      // Get current story graph
      const storyResult = await pool.query(
        `
        SELECT story_graph FROM project_stories WHERE project_id = $1
      `,
        [id],
      );

      if (storyResult.rows.length === 0 || !storyResult.rows[0].story_graph) {
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph;

      // Validate node exists
      if (!Object.hasOwn(storyGraph.nodes, nodeId)) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      // Validate target exists (allow END/DONE as special targets)
      if (
        choice.target !== 'END' &&
        choice.target !== 'DONE' &&
        !Object.hasOwn(storyGraph.nodes, choice.target)
      ) {
        res.status(400).json({ error: `Choice target '${choice.target}' does not exist in story` });
        return;
      }

      // Initialize choices array if needed
      if (!storyGraph.nodes[nodeId].choices) {
        storyGraph.nodes[nodeId].choices = [];
      }

      // Add the choice at specified index or at the end
      if (
        atIndex !== undefined &&
        atIndex >= 0 &&
        atIndex <= storyGraph.nodes[nodeId].choices.length
      ) {
        storyGraph.nodes[nodeId].choices.splice(atIndex, 0, choice);
      } else {
        storyGraph.nodes[nodeId].choices.push(choice);
      }

      // Save updated story graph
      await pool.query(
        `
        UPDATE project_stories
        SET story_graph = $1, updated_at = CURRENT_TIMESTAMP,
            ink_source = NULL, twee_source = NULL
        WHERE project_id = $2
      `,
        [JSON.stringify(storyGraph), id],
      );

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      // Structural change — drop the live Y.Doc room so connected
      // clients reseed against the new choices array instead of
      // flushing a stale length back over us.
      await invalidateRoom(id);

      res.json({
        success: true,
        story_graph: storyGraph,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to add choice');
      res.status(500).json({ error: 'Failed to add choice' });
    }
  });

  // Update node divert target in story graph
  router.patch('/:id/story/divert', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, newTarget } = req.body;

      if (!nodeId || newTarget === undefined) {
        res.status(400).json({ error: 'nodeId and newTarget are required' });
        return;
      }

      if (typeof nodeId !== 'string' || (newTarget !== null && typeof newTarget !== 'string')) {
        res
          .status(400)
          .json({ error: 'nodeId must be a string, newTarget must be a string or null' });
        return;
      }

      // Get current story graph
      const storyResult = await pool.query(
        `
        SELECT story_graph FROM project_stories WHERE project_id = $1
      `,
        [id],
      );

      if (storyResult.rows.length === 0 || !storyResult.rows[0].story_graph) {
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph;

      // Validate node exists
      if (!Object.hasOwn(storyGraph.nodes, nodeId)) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      // Validate target exists (unless it's END, DONE, or null)
      if (newTarget !== null) {
        if (newTarget === '') {
          res.status(400).json({ error: 'newTarget must be a non-empty string or null' });
          return;
        }
        if (
          newTarget !== 'END' &&
          newTarget !== 'DONE' &&
          !Object.hasOwn(storyGraph.nodes, newTarget)
        ) {
          res.status(400).json({ error: 'Target node not found' });
          return;
        }
      }

      // Update the divert target
      storyGraph.nodes[nodeId].divert = newTarget;

      // Save updated story graph
      await pool.query(
        `
        UPDATE project_stories
        SET story_graph = $1, updated_at = CURRENT_TIMESTAMP,
            ink_source = NULL, twee_source = NULL
        WHERE project_id = $2
      `,
        [JSON.stringify(storyGraph), id],
      );

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      // Y.Doc still holds the pre-PATCH divert scalar; without
      // invalidation the next shadow-save would flush it back. See
      // the longer comment on the choice-target endpoint above.
      await invalidateRoom(id);

      res.json({
        success: true,
        story_graph: storyGraph,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update divert target');
      res.status(500).json({ error: 'Failed to update divert target' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/story/node/rename:
   *   patch:
   *     summary: Rename a node.
   *     description: |
   *       Renames a story node in one server-side transaction:
   *       (1) reassigns the key in `story_graph.nodes`, (2) rewrites
   *       every choice.target / node.divert / stitch.parent that
   *       referenced the old id, (3) updates `story_graph.startNode`
   *       when it pointed at the old id, and (4) migrates the two
   *       side tables (`node_audio_assignments`, `node_metadata`) so
   *       audio + timing overrides stay attached to the renamed node.
   *
   *       Rejects when the new id is empty / equal / already taken.
   *       For Twee-sourced projects also rejects new ids containing
   *       `[`, `]`, `|`, `->`, or `<-` (would corrupt link markup on
   *       export — same guard the parser applies at import time).
   *
   *       Clears the cached ink/twee source columns so the next
   *       `/exports/:format` re-emits from the renamed graph.
   *     tags: [Story]
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
   *             required: [oldId, newId]
   *             properties:
   *               oldId: { type: string }
   *               newId: { type: string }
   *     responses:
   *       200: { description: Renamed. }
   *       400: { description: 'Bad request (empty ids, equal ids, unsafe name).' }
   *       404: { description: Story or old node not found. }
   *       409: { description: newId is already used by another node. }
   */
  router.patch('/:id/story/node/rename', async (req: Request, res: Response) => {
    const { id } = req.params;
    const rawOld = req.body?.oldId;
    const rawNew = req.body?.newId;

    if (typeof rawOld !== 'string' || typeof rawNew !== 'string') {
      res.status(400).json({ error: 'oldId and newId must be strings' });
      return;
    }
    const oldId = rawOld;
    const newId = rawNew.trim();
    if (!oldId || !newId) {
      res.status(400).json({ error: 'oldId and newId must be non-empty' });
      return;
    }
    if (oldId === newId) {
      res.status(400).json({ error: 'newId must differ from oldId' });
      return;
    }

    const client = await pool.connect();
    let renamedGraph: unknown = null;
    try {
      await client.query('BEGIN');

      const storyResult = await client.query(
        `SELECT story_graph, source_language
         FROM project_stories
         WHERE project_id = $1
         FOR UPDATE`,
        [id],
      );
      if (storyResult.rows.length === 0 || !storyResult.rows[0].story_graph) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph as {
        nodes: Record<
          string,
          {
            id?: string;
            choices?: { target: string }[];
            divert?: string | null;
            parent?: string | null;
          }
        >;
        startNode: string;
      };
      const sourceLanguage = storyResult.rows[0].source_language as 'ink' | 'twee' | null;

      if (!Object.hasOwn(storyGraph.nodes, oldId)) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      if (Object.hasOwn(storyGraph.nodes, newId)) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: `newId "${newId}" is already used by another node` });
        return;
      }
      // The cascade re-keys every stitch under the renamed knot from
      // `${oldId}.<name>` → `${newId}.<name>`. If ANY of those new
      // keys already exists (orphan row, prior aborted rename, hand-
      // edited JSONB), the in-memory `nodes[newKey] = stitch` would
      // silently clobber the existing entry. Pre-scan and 409 so the
      // author can rename the collision first.
      const oldPrefixCheck = oldId + '.';
      const newPrefixCheck = newId + '.';
      for (const nodeKey of Object.keys(storyGraph.nodes)) {
        if (!nodeKey.startsWith(oldPrefixCheck)) continue;
        const candidate = newPrefixCheck + nodeKey.slice(oldPrefixCheck.length);
        if (Object.hasOwn(storyGraph.nodes, candidate)) {
          await client.query('ROLLBACK');
          res.status(409).json({
            error: `Renaming "${oldId}" to "${newId}" would collide with existing node "${candidate}". Rename or remove that node first.`,
          });
          return;
        }
      }

      // Twee 3 has no defined escape for the link/tag/metadata
      // delimiters, and the parser rejects passage names containing
      // them at import — reject here too so a rename can't leave the
      // graph in a state that fails its own export.
      if (sourceLanguage === 'twee') {
        const unsafe = /[[\]|]|->|<-/;
        if (unsafe.test(newId)) {
          await client.query('ROLLBACK');
          res.status(400).json({
            error:
              'newId contains a character that is unsafe for Twee export (`[`, `]`, `|`, `->`, or `<-`). Choose a different name.',
          });
          return;
        }
      }

      // Rewrite the graph. Renaming a knot has to cascade through:
      //   1. the renamed node's own `id` (nodes[newId].id was oldId).
      //   2. every stitch keyed as `${oldId}.<name>` — the map key
      //      and the node's own `id` field both carry the stale
      //      prefix; rewrite to `${newId}.<name>`.
      //   3. every choice.target / node.divert that pointed at the
      //      old id OR at a stitch under it (`${oldId}.<name>`).
      //   4. every node.parent that equalled oldId.
      //   5. graph.startNode.
      // Iterate before mutating so we don't hit the freshly-inserted
      // keys during the walk.
      const oldPrefix = oldId + '.';
      const renamedNode = storyGraph.nodes[oldId];
      renamedNode.id = newId;
      delete storyGraph.nodes[oldId];
      storyGraph.nodes[newId] = renamedNode;
      if (storyGraph.startNode === oldId) {
        storyGraph.startNode = newId;
      }
      // Snapshot keys first so re-keying stitches doesn't corrupt
      // the iteration.
      const originalKeys = Object.keys(storyGraph.nodes);
      for (const nodeKey of originalKeys) {
        // Re-key stitches whose id started with `${oldId}.`.
        if (nodeKey.startsWith(oldPrefix)) {
          const suffix = nodeKey.slice(oldPrefix.length);
          const newStitchKey = newId + '.' + suffix;
          const stitch = storyGraph.nodes[nodeKey];
          if (stitch.id === nodeKey) stitch.id = newStitchKey;
          delete storyGraph.nodes[nodeKey];
          storyGraph.nodes[newStitchKey] = stitch;
        }
      }
      const rewriteReference = (ref: string | null | undefined): string | null | undefined => {
        if (ref == null) return ref;
        if (ref === oldId) return newId;
        if (ref.startsWith(oldPrefix)) return newId + '.' + ref.slice(oldPrefix.length);
        return ref;
      };
      for (const nodeKey of Object.keys(storyGraph.nodes)) {
        const node = storyGraph.nodes[nodeKey];
        if (Array.isArray(node.choices)) {
          for (const choice of node.choices) {
            const nextTarget = rewriteReference(choice.target);
            if (typeof nextTarget === 'string' && nextTarget !== choice.target) {
              choice.target = nextTarget;
            }
          }
        }
        const nextDivert = rewriteReference(node.divert ?? null);
        if (nextDivert !== (node.divert ?? null)) {
          node.divert = (nextDivert as string | null) ?? null;
        }
        // parent is the KNOT id (never dotted), so plain equality is
        // enough — no prefix-rewrite path.
        if (node.parent === oldId) node.parent = newId;
      }

      await client.query(
        `UPDATE project_stories
         SET story_graph = $1, updated_at = CURRENT_TIMESTAMP,
             ink_source = NULL, twee_source = NULL
         WHERE project_id = $2`,
        [JSON.stringify(storyGraph), id],
      );
      // Side tables keyed by (project_id, node_id) — audio + timing
      // overrides for BOTH the renamed knot AND every stitch under
      // it (`${oldId}.<name>`) must follow the rename. The CASE
      // handles both: exact match → replace whole node_id; prefix
      // match → replace the leading `oldId` with `newId`, keeping
      // the `.<stitch>` tail.
      //
      // Prefix match uses `left(node_id, length($2) + 1) = $2 || '.'`
      // rather than `LIKE $2 || '.%'` because `LIKE` treats `%` and
      // `_` in oldId as wildcards — a rename of a node id containing
      // those characters would silently migrate rows for unrelated
      // nodes.
      const renameSideTable = async (table: 'node_audio_assignments' | 'node_metadata') => {
        await client.query(
          `UPDATE ${table}
           SET node_id = CASE
               WHEN node_id = $2 THEN $3
               ELSE $3 || substring(node_id FROM length($2) + 1)
             END
           WHERE project_id = $1
             AND (node_id = $2 OR left(node_id, length($2) + 1) = $2 || '.')`,
          [id, oldId, newId],
        );
      };
      await renameSideTable('node_audio_assignments');
      await renameSideTable('node_metadata');
      await client.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
      await client.query('COMMIT');
      renamedGraph = storyGraph;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      req.log.error({ err: error }, 'Failed to rename node');
      res.status(500).json({ error: 'Failed to rename node' });
      return;
    } finally {
      client.release();
    }

    // Y.Doc still holds a nodes map keyed by the OLD id; the next
    // shadow-save would resurrect it. Drop the collab room so peers
    // reconnect against the renamed graph. Runs OUTSIDE the
    // transaction try/catch — a collab-server hiccup here shouldn't
    // ROLLBACK a committed rename or 500 to the user; the peers
    // will pick up the change on their next fetch either way.
    invalidateRoom(id).catch((err) => {
      req.log.warn({ err }, 'invalidateRoom failed after rename; peers may need to reconnect');
    });

    res.json({ success: true, story_graph: renamedGraph });
  });

  /**
   * @openapi
   * /projects/{id}/exports/{format}:
   *   get:
   *     summary: Export the project's story in Ink or Twee 3 format.
   *     description: |
   *       Returns the story as text in the requested format.
   *       Serves the persisted authoritative source when it matches
   *       `format`; otherwise regenerates from `story_graph` via the
   *       appropriate emitter and caches the result in the matching
   *       source column so subsequent exports are instant until the
   *       next edit.
   *     tags: [Story]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: format
   *         required: true
   *         schema: { type: string, enum: [ink, twee] }
   *     responses:
   *       200:
   *         description: Source text in the requested format.
   *         content:
   *           text/plain:
   *             schema: { type: string }
   *       400: { description: Unknown format. }
   *       404: { description: Project has no story. }
   */
  router.get('/:id/exports/:format', async (req: Request, res: Response) => {
    try {
      const { id, format } = req.params;
      if (format !== 'ink' && format !== 'twee') {
        res.status(400).json({ error: `Unknown export format: ${format}` });
        return;
      }

      const result = await pool.query(
        `SELECT story_graph, ink_source, twee_source, source_language
         FROM project_stories
         WHERE project_id = $1`,
        [id],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Project has no story' });
        return;
      }
      const row = result.rows[0];

      // If the persisted source matches the requested format, serve
      // it verbatim — the byte-perfect round-trip beats a re-emit.
      const cachedSource = format === 'ink' ? row.ink_source : row.twee_source;
      if (cachedSource) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="story.${format === 'twee' ? 'tw3' : 'ink'}"`,
        );
        res.send(cachedSource);
        return;
      }

      // If both cached sources are NULL AND story_graph is NULL, the
      // project_stories row exists but carries nothing to export
      // (possible for earlier rows that never had a successful
      // upload, or after a corrupted/aborted ingest). Return 404
      // instead of crashing the emitter on a null graph.
      if (!row.story_graph) {
        res.status(404).json({ error: 'Project has no story' });
        return;
      }

      // Regenerate from the graph via the appropriate emitter and
      // cache the result so subsequent same-format exports skip the
      // emit step.
      const emitted = format === 'ink' ? emitInk(row.story_graph) : emitTwee(row.story_graph);
      const cacheColumn = format === 'ink' ? 'ink_source' : 'twee_source';
      await pool.query(`UPDATE project_stories SET ${cacheColumn} = $2 WHERE project_id = $1`, [
        id,
        emitted,
      ]);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="story.${format === 'twee' ? 'tw3' : 'ink'}"`,
      );
      res.send(emitted);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to export story');
      res.status(500).json({ error: 'Failed to export story' });
    }
  });
}
