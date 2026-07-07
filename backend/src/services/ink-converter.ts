/**
 * Converts a story graph back to Ink format.
 * Extracted from projects.ts for reuse.
 */

interface InkStoryGraph {
  id: string;
  title: string;
  nodes: Record<
    string,
    {
      id: string;
      type: 'knot' | 'stitch' | 'gather';
      content: { text: string; tags: string[] }[];
      choices: { text: string; target: string }[];
      divert: string | null;
      tags: string[];
    }
  >;
  startNode: string;
}

/**
 * `emitInk` — the round-trip counterpart to
 * `emitTwee` in twee-emitter.ts. Alias for the existing
 * `convertStoryGraphToInk` so both format emitters have symmetric
 * naming. Kept the original name as an export too for backwards
 * compatibility with anything that imported it before.
 */
export function emitInk(storyGraph: InkStoryGraph): string {
  return convertStoryGraphToInk(storyGraph);
}

export function convertStoryGraphToInk(storyGraph: InkStoryGraph): string {
  const lines: string[] = [];
  const nodes = storyGraph.nodes;
  const processedNodes = new Set<string>();

  // sanitize a StoryNode id into a legal Ink knot / stitch
  // identifier. Ink allows only `[A-Za-z_][A-Za-z0-9_]*`, but Twee
  // 3 (and future Ink extensions) allow arbitrary characters
  // including whitespace and hyphens. Replace runs of illegal
  // characters with `_` and strip leading digits so the emitted
  // `.ink` file re-parses. Collisions between two sanitised names
  // are broken by suffixing a stable index — we build the id map
  // once and reuse it everywhere target/reference names appear.
  const sanitize = (name: string): string => {
    let out = name.replace(/[^A-Za-z0-9_]+/g, '_');
    if (/^[0-9]/.test(out)) out = '_' + out;
    if (!out) out = '_';
    return out;
  };
  const idMap: Record<string, string> = {};
  {
    const used = new Set<string>();
    for (const nodeId of Object.keys(nodes)) {
      let candidate = sanitize(nodeId);
      let suffix = 1;
      const base = candidate;
      while (used.has(candidate)) {
        suffix++;
        candidate = `${base}_${suffix}`;
      }
      used.add(candidate);
      idMap[nodeId] = candidate;
    }
  }
  const inkId = (nodeId: string): string => idMap[nodeId] ?? sanitize(nodeId);

  // Helper to get the parent knot of a stitch
  const getParentKnot = (stitchId: string): string | null => {
    if (!stitchId.includes('.')) return null;
    return stitchId.split('.')[0];
  };

  // Helper to format a node reference for Ink. Sanitises via inkId
  // so a Twee-imported graph with names like `The Kitchen` reaches
  // Ink as `The_Kitchen`. The short-form path (stitch in the same
  // knot) resolves against the full nodeId and then strips the
  // sanitised knot prefix — that way any collisions our idMap
  // resolved are preserved on both sides of the reference.
  const formatTarget = (target: string, currentKnot: string | null): string => {
    if (target === 'END' || target === 'DONE') return target;
    const sanitisedTarget = inkId(target);
    if (currentKnot && target.startsWith(currentKnot + '.')) {
      const sanitisedKnot = inkId(currentKnot);
      if (sanitisedTarget.startsWith(sanitisedKnot + '_')) {
        return sanitisedTarget.slice(sanitisedKnot.length + 1);
      }
    }
    return sanitisedTarget;
  };

  // Process a single node
  const processNode = (nodeId: string, currentKnot: string | null) => {
    if (processedNodes.has(nodeId)) return;
    processedNodes.add(nodeId);

    const node = nodes[nodeId];
    if (!node) return;

    // Write node header. Sanitise both the knot and the stitch
    // suffix so `:: The Kitchen` from Twee lands as
    // `=== The_Kitchen ===` in Ink instead of an unparseable
    // `=== The Kitchen ===`.
    if (node.type === 'knot') {
      lines.push('');
      lines.push(`=== ${inkId(node.id)} ===`);
    } else if (node.type === 'stitch') {
      const sanitisedFull = inkId(node.id);
      const parent = getParentKnot(node.id);
      let stitchName: string;
      if (parent) {
        const sanitisedParent = inkId(parent);
        stitchName = sanitisedFull.startsWith(sanitisedParent + '_')
          ? sanitisedFull.slice(sanitisedParent.length + 1)
          : sanitisedFull;
      } else {
        stitchName = sanitisedFull;
      }
      lines.push('');
      lines.push(`= ${stitchName}`);
    }

    // Write node-level tags
    for (const tag of node.tags) {
      lines.push(`# ${tag}`);
    }

    // Write content
    for (const content of node.content) {
      // Write content tags inline
      let line = content.text;
      if (content.tags.length > 0) {
        line += ' ' + content.tags.map((t) => `# ${t}`).join(' ');
      }
      lines.push(line);
    }

    // Write choices
    for (const choice of node.choices) {
      const target = formatTarget(choice.target, currentKnot);
      lines.push(`* [${choice.text}] -> ${target}`);
    }

    // Write divert (if no choices)
    if (node.choices.length === 0 && node.divert) {
      const target = formatTarget(node.divert, currentKnot);
      lines.push(`-> ${target}`);
    }
  };

  // Group nodes by knot
  const knots: Record<string, string[]> = {};
  const topLevelKnots: string[] = [];

  for (const nodeId of Object.keys(nodes)) {
    const node = nodes[nodeId];
    if (node.type === 'knot') {
      topLevelKnots.push(nodeId);
      knots[nodeId] = [];
    } else if (node.type === 'stitch') {
      const parent = getParentKnot(nodeId);
      if (parent) {
        if (!knots[parent]) knots[parent] = [];
        knots[parent].push(nodeId);
      }
    }
  }

  // Sort knots, putting start node first
  topLevelKnots.sort((a, b) => {
    if (a === storyGraph.startNode) return -1;
    if (b === storyGraph.startNode) return 1;
    return a.localeCompare(b);
  });

  // Process knots and their stitches
  for (const knotId of topLevelKnots) {
    processNode(knotId, knotId);

    // Process stitches within this knot
    const stitches = knots[knotId] || [];
    stitches.sort((a, b) => a.localeCompare(b));
    for (const stitchId of stitches) {
      processNode(stitchId, knotId);
    }
  }

  // Process any remaining nodes (gathers, etc.)
  for (const nodeId of Object.keys(nodes)) {
    if (!processedNodes.has(nodeId)) {
      processNode(nodeId, null);
    }
  }

  return lines.join('\n');
}
