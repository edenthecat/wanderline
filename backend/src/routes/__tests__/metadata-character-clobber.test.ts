// The metadata upsert bound NULL for an omitted characterId, and the
// SQL treated NULL as "clear it". So saving the transcript override or
// the timing settings silently unassigned the node's character — an
// author could attach one and watch it vanish on their next edit.
//
// This pins the parameter contract rather than the SQL: absent must be
// distinguishable from explicitly-null at the point of binding.

import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(process.cwd(), 'src/routes/metadata.ts'), 'utf-8');

describe('node metadata character_id contract', () => {
  it('passes a separate flag for whether characterId was supplied', () => {
    expect(source).toContain('characterId !== undefined,');
  });

  // The old form cleared the column whenever the bound value was null,
  // which an omitted key always produced.
  it('no longer keys the update on the value being null', () => {
    expect(source).not.toContain('$11::uuid IS NULL AND node_metadata.character_id IS NOT NULL');
  });

  it('updates character_id only when the flag says the key was present', () => {
    expect(source).toMatch(/character_id = CASE WHEN \$12::boolean THEN \$11::uuid ELSE/);
  });

  // Assigning a character still has to be validated against the project.
  it('still validates a supplied characterId belongs to the project', () => {
    expect(source).toContain('SELECT id FROM characters WHERE id = $1 AND project_id = $2');
  });
});
