// Ids reach Postgres UUID columns directly. Without a shape check a
// malformed one raises `invalid input syntax for type uuid`, which the
// catch turns into a 500 and an error-level log for what is really a
// bad request — and requireProjectAccess short-circuits admins before
// its collaborators query, so a non-UUID project id can reach here too.
//
// Pins the guards as source contracts rather than standing up Express,
// matching how the metadata character-clobber contract is covered.

import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(process.cwd(), 'src/routes/projects-flags.ts'), 'utf-8');

describe('node flag route guards', () => {
  it('validates ids before they reach a uuid column', () => {
    expect(source).toMatch(/const UUID_RE = /);
    // All three handlers, plus flagId on the resolve path.
    expect(source.match(/UUID_RE\.test\(id\)/g)?.length).toBe(3);
    expect(source).toContain('UUID_RE.test(flagId)');
  });

  it('rejects a bad id as a client error rather than a server one', () => {
    expect(source).toContain("res.status(400).json({ error: 'Invalid project id' })");
    expect(source).toContain("res.status(400).json({ error: 'Invalid project or flag id' })");
  });

  // The list is read on every Story/Graph mount and each flag carries a
  // note of up to 2000 characters.
  it('caps the list and reports the true total alongside it', () => {
    expect(source).toMatch(/const MAX_FLAGS_RETURNED = \d+/);
    expect(source).toContain('LIMIT $2');
    expect(source).toContain('total:');
    expect(source).toContain('truncated:');
  });

  // A closed set keeps the editor, the graph and the roll-up rendering
  // the same three reasons.
  it('only accepts the three known reasons', () => {
    expect(source).toContain("'not_working', 'incorrect_audio', 'needs_text_edit'");
    expect(source).toContain('REASONS.has(reason)');
  });

  // Resolving must not be reachable across projects via a flag id.
  it('scopes resolve by project and to open flags only', () => {
    expect(source).toMatch(/WHERE id = \$1 AND project_id = \$2\s+AND resolved_at IS NULL/);
  });
});
