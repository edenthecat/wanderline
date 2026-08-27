// Audio filename → story node matcher.
//
// Pulled out of the bulk-upload + rematch endpoints so both share a
// single source of truth. Two endpoints with subtly different copies
// of "guess where this file belongs" is how we got an asymmetric
// matcher last time around — the rematch path lacked the DAW-prefix
// stripping the bulk path had grown.
//
// Matching ladder (each step gets a chance to claim a file):
//   1. Choice patterns built from node id + choice text/target.
//   2. Voiceover by exact node id (incl. ./_-separator variations).
//   3. Voiceover by stitch-only name.
//   4. Voiceover with common author prefixes stripped (vo_, voiceover_,
//      audio_, narration_).
//   5. Voiceover with aggressive DAW-export normalization (numeric
//      track prefix and version/take suffix removed).
//   6. Choice-position suffix: <node>_choice_a / <node>.choice_b →
//      choice index 0 / 1 (the most common author convention seen
//      in real project uploads).
//   7. Levenshtein fallback (≤ 2 edits) for short typos.
//
// First match wins. Returns null for "no plausible target".

export interface StoryNodeForMatching {
  id: string;
  tags?: string[];
  choices?: { text: string; target: string }[];
}

export interface AudioMatch {
  nodeId: string;
  audioType: 'voiceover' | 'choice1' | 'choice2';
}

export interface CompiledMatchTables {
  matchMap: Map<string, string>;
  choiceMatchMap: Map<string, { nodeId: string; choiceIndex: number }>;
  // Node ids in canonical lowercased form, used for the Levenshtein
  // fallback. Order is deterministic so ties resolve consistently.
  nodeIdsLower: string[];
}

export function buildMatchTables(nodes: Record<string, StoryNodeForMatching>): CompiledMatchTables {
  const matchMap = new Map<string, string>();
  const choiceMatchMap = new Map<string, { nodeId: string; choiceIndex: number }>();
  const nodeIds = Object.keys(nodes);

  // Pass 1: fully-qualified ids, in all three separator spellings.
  // These are unique by construction and must never be displaced by a
  // weaker match, so they go down first and later passes refuse to
  // overwrite them.
  for (const nodeId of nodeIds) {
    matchMap.set(nodeId.toLowerCase(), nodeId);
    matchMap.set(nodeId.toLowerCase().replace(/\./g, '_'), nodeId);
    matchMap.set(nodeId.toLowerCase().replace(/\./g, '-'), nodeId);
  }

  // Pass 2: bare stitch names ("intro" for "chapter1.intro").
  //
  // These are a convenience, and they are NOT unique: reusing a stitch
  // name across knots is idiomatic Ink — namespacing them under a knot
  // is the whole point of the feature. Previously this did an
  // unguarded `set`, which produced two silent mis-assignments:
  //
  //   - A stitch's bare name overwrote a same-named KNOT's exact id,
  //     so audio named "intro.mp3" attached to "chapter1.intro"
  //     instead of the knot "intro".
  //   - Two stitches sharing a name resolved to whichever was parsed
  //     last, arbitrarily.
  //
  // So: collect first, then only register names that identify exactly
  // one node and don't collide with a qualified id. An ambiguous name
  // is left unmatched deliberately — an author who sees audio go
  // unassigned will go and look, whereas one whose audio was attached
  // to a plausible-but-wrong passage may never notice.
  const bareNameOwners = new Map<string, string[]>();
  for (const nodeId of nodeIds) {
    const parts = nodeId.split('.');
    if (parts.length < 2) continue;
    const bare = parts[parts.length - 1].toLowerCase();
    const owners = bareNameOwners.get(bare);
    if (owners) owners.push(nodeId);
    else bareNameOwners.set(bare, [nodeId]);
  }
  const ambiguousBareNames = new Set<string>();
  for (const [bare, owners] of bareNameOwners) {
    if (owners.length > 1) {
      ambiguousBareNames.add(bare);
      continue;
    }
    if (matchMap.has(bare)) continue; // a qualified id already claims it
    matchMap.set(bare, owners[0]);
  }

  // Pass 3: tags. Weakest signal, so it yields to everything above —
  // including a bare name we deliberately refused to register, since
  // that name is ambiguous and a tag pointing at one of the candidates
  // would reintroduce the same guesswork.
  for (const nodeId of nodeIds) {
    const node = nodes[nodeId];
    if (!node?.tags) continue;
    for (const tag of node.tags) {
      const key = tag.toLowerCase();
      if (matchMap.has(key) || ambiguousBareNames.has(key)) continue;
      matchMap.set(key, nodeId);
    }
  }

  for (const nodeId of nodeIds) {
    const node = nodes[nodeId];
    if (!node?.choices) continue;
    const nodeNameLower = nodeId.toLowerCase();
    const nodeNameUnderscore = nodeNameLower.replace(/\./g, '_');

    node.choices.forEach((choice, index) => {
      if (index > 1) return;
      const choiceTextNorm = choice.text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
      const choiceTargetNorm = choice.target.toLowerCase().replace(/\./g, '_');
      const choiceTargetLastPart = choice.target.split('.').pop()?.toLowerCase() || '';
      const patterns = [
        `${nodeNameLower}.${choiceTextNorm}`,
        `${nodeNameUnderscore}_${choiceTextNorm}`,
        `${nodeNameLower}.${choiceTargetNorm}`,
        `${nodeNameUnderscore}_${choiceTargetNorm}`,
        `${nodeNameLower}.${choiceTargetLastPart}`,
        `${nodeNameUnderscore}_${choiceTargetLastPart}`,
        ...(nodeId.includes('.')
          ? [
              `${nodeId.split('.').pop()?.toLowerCase()}.${choiceTextNorm}`,
              `${nodeId.split('.').pop()?.toLowerCase()}_${choiceTextNorm}`,
              `${nodeId.split('.').pop()?.toLowerCase()}.${choiceTargetLastPart}`,
              `${nodeId.split('.').pop()?.toLowerCase()}_${choiceTargetLastPart}`,
            ]
          : []),
      ];
      for (const pattern of patterns) {
        if (!choiceMatchMap.has(pattern)) {
          choiceMatchMap.set(pattern, { nodeId, choiceIndex: index });
        }
      }
    });
  }

  return { matchMap, choiceMatchMap, nodeIdsLower: nodeIds.map((n) => n.toLowerCase()) };
}

// Position-based choice suffix. Authors commonly name choice audio
// files after the node + a positional letter — "<node>_choice_a.wav"
// (= choice 1) and "<node>_choice_b.wav" (= choice 2). The dot form
// "<node>.choice_a.wav" comes up too. Without this, the matcher had
// to find an exact text/target hit, which fails for short choices
// (single-letter responses) or rephrased ones.
const CHOICE_SUFFIX_RE = /^(?<node>.+?)[._]choice[._]([ab12])$/i;

// Strip a DAW track-number prefix and version/take suffix. Returns
// the input untouched if nothing applied.
function stripDawNoise(name: string): string {
  return name
    .replace(/^[\d]+[._\-\s]*/, '')
    .replace(/[._\-\s]?(v\d+|take[_\s]?\d+|final|alt|edit|master)$/i, '')
    .replace(/[._\-\s]?\(\d+\)$/, '')
    .replace(/^_+|_+$/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[b.length][a.length];
}

// Find the closest node id by Levenshtein. Only returns a match when:
//   - the shortest distance is ≤ MAX_DISTANCE (covers small typos
//     like "dostevsky" → "dostoevsky"), AND
//   - the closest is at least 2 edits closer than the runner-up, so
//     we don't blindly assign when two nodes are equally typo-close.
function fuzzyVoiceoverMatch(name: string, tables: CompiledMatchTables): { nodeId: string } | null {
  const MAX_DISTANCE = 2;
  // Skip very short inputs — at name.length 2, "ab" → "xy" is also
  // distance 2 but that's nonsense.
  if (name.length < 5) return null;

  let best = { dist: Infinity, id: '' };
  let runnerUp = Infinity;
  for (const nodeLower of tables.nodeIdsLower) {
    if (Math.abs(nodeLower.length - name.length) > MAX_DISTANCE) continue;
    const d = levenshtein(name, nodeLower);
    if (d < best.dist) {
      runnerUp = best.dist;
      best = { dist: d, id: nodeLower };
    } else if (d < runnerUp) {
      runnerUp = d;
    }
  }
  if (best.dist <= MAX_DISTANCE && runnerUp - best.dist >= 2) {
    const original = tables.matchMap.get(best.id);
    if (original) return { nodeId: original };
  }
  return null;
}

/**
 * Resolve an audio file's original name to a story-node target.
 * Returns the match or null. Caller decides what to do with null
 * (mark unmatched, surface in UI, etc.).
 */
export function matchAudioFile(
  originalName: string,
  tables: CompiledMatchTables,
): AudioMatch | null {
  const baseName = originalName.replace(/\.[^.]+$/, '').toLowerCase();
  const normalizedName = baseName.replace(/\s+/g, '_');
  const stripped = stripDawNoise(normalizedName);

  // 1. Choice match by curated patterns from text/target.
  for (const candidate of [baseName, normalizedName]) {
    const m = tables.choiceMatchMap.get(candidate);
    if (m) return { nodeId: m.nodeId, audioType: m.choiceIndex === 0 ? 'choice1' : 'choice2' };
  }

  // 2. Voiceover by node id (exact / separator-swapped).
  for (const candidate of [baseName, normalizedName]) {
    const nid = tables.matchMap.get(candidate);
    if (nid) return { nodeId: nid, audioType: 'voiceover' };
  }

  // 2c. Underscores → dots fallback (common for knot.stitch names).
  if (normalizedName.includes('_')) {
    const dotVersion = normalizedName.replace(/_/g, '.');
    const nid = tables.matchMap.get(dotVersion);
    if (nid) return { nodeId: nid, audioType: 'voiceover' };
  }

  // 2d. Author prefixes.
  const prefixPatterns = ['vo_', 'voiceover_', 'audio_', 'narration_'];
  for (const prefix of prefixPatterns) {
    if (normalizedName.startsWith(prefix)) {
      const withoutPrefix = normalizedName.substring(prefix.length);
      const nid = tables.matchMap.get(withoutPrefix);
      if (nid) return { nodeId: nid, audioType: 'voiceover' };
    }
  }

  // 2e. Aggressively-stripped name.
  if (stripped && stripped !== normalizedName) {
    const m = tables.choiceMatchMap.get(stripped);
    if (m) return { nodeId: m.nodeId, audioType: m.choiceIndex === 0 ? 'choice1' : 'choice2' };
    let nid = tables.matchMap.get(stripped);
    if (nid) return { nodeId: nid, audioType: 'voiceover' };
    const strippedDots = stripped.replace(/_/g, '.');
    nid = tables.matchMap.get(strippedDots);
    if (nid) return { nodeId: nid, audioType: 'voiceover' };
  }

  // 3. Positional choice suffix: <node>_choice_a → choice 1.
  // Real-world author pattern; the curated text/target patterns above
  // miss it when the choice text is short, rephrased, or numeric.
  for (const candidate of [baseName, normalizedName, stripped]) {
    if (!candidate) continue;
    const m = candidate.match(CHOICE_SUFFIX_RE);
    if (!m) continue;
    const nodeBase = m.groups?.node ?? '';
    const slot = (m[2] || '').toLowerCase();
    const choiceIndex = slot === 'a' || slot === '1' ? 0 : 1;
    const nid = tables.matchMap.get(nodeBase) ?? tables.matchMap.get(nodeBase.replace(/\./g, '_'));
    if (nid) {
      return { nodeId: nid, audioType: choiceIndex === 0 ? 'choice1' : 'choice2' };
    }
  }

  // 4. Levenshtein typo fallback.
  const fuzzy = fuzzyVoiceoverMatch(normalizedName, tables);
  if (fuzzy) return { nodeId: fuzzy.nodeId, audioType: 'voiceover' };

  return null;
}
