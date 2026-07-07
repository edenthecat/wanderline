/**
 * Ink JSON Parser Service
 * Parses compiled .ink.json files into the Wanderline story graph format
 *
 * The compiled Ink JSON format (inkVersion 21) has this structure:
 * {
 *   "inkVersion": 21,
 *   "root": [
 *     [...], // Global content
 *     "done", // End marker
 *     { // Named content (knots/stitches)
 *       "knot_name": [
 *         [...content...],
 *         { "#f": flags, "stitch_name": [...], ... }
 *       ]
 *     }
 *   ],
 *   "listDefs": {}
 * }
 */

import type { StoryGraph, StoryNode, ValidationResult, ValidationMessage } from '../types.js';

export type { StoryGraph, StoryNode, ValidationResult };

interface InkJson {
  inkVersion: number;
  root: [unknown[], string, Record<string, unknown[]>];
  listDefs?: Record<string, unknown>;
}

/**
 * Parse a compiled Ink JSON file into a StoryGraph
 */
export function parseInkJson(jsonContent: string, storyId: string, title?: string): StoryGraph {
  const inkData: InkJson = JSON.parse(jsonContent);

  if (!inkData.inkVersion) {
    throw new Error('Invalid Ink JSON: missing inkVersion');
  }

  if (!inkData.root || !Array.isArray(inkData.root) || inkData.root.length < 3) {
    throw new Error('Invalid Ink JSON: invalid root structure');
  }

  const nodes: Record<string, StoryNode> = {};
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];

  // Get the named content (knots)
  const namedContent = inkData.root[2] as Record<string, unknown[]>;

  // Also parse root content (content before first knot)
  const rootContent = inkData.root[0] as unknown[];
  if (rootContent && Array.isArray(rootContent) && rootContent.length > 0) {
    const introNode = parseKnotContent('_intro', rootContent, null);
    if (introNode.content.length > 0 || introNode.choices.length > 0) {
      nodes['_intro'] = introNode;
    }
  }

  // Parse each knot
  for (const [knotName, knotData] of Object.entries(namedContent)) {
    if (!Array.isArray(knotData) || knotData.length < 1) continue;

    const contentArray = knotData[0] as unknown[];
    const metadata = knotData[1] as Record<string, unknown> | undefined;

    // Parse the knot
    const knotNode = parseKnotContent(knotName, contentArray, null);
    knotNode.type = 'knot';
    nodes[knotName] = knotNode;

    // Parse stitches (nested in metadata, excluding #f)
    if (metadata && typeof metadata === 'object') {
      for (const [key, value] of Object.entries(metadata)) {
        if (key === '#f') continue; // Skip flags

        if (Array.isArray(value)) {
          // Stitch content can be:
          // 1. Nested: [[...content...], {#f: ...}]
          // 2. Direct: [...content..., {#f: ...}]
          let stitchContent: unknown[];
          if (value.length > 0 && Array.isArray(value[0])) {
            // Nested format
            stitchContent = value[0] as unknown[];
          } else {
            // Direct format - the value array IS the content
            stitchContent = value;
          }

          const stitchId = `${knotName}.${key}`;
          const stitchNode = parseKnotContent(stitchId, stitchContent, knotName);
          stitchNode.type = 'stitch';
          nodes[stitchId] = stitchNode;
        }
      }
    }
  }

  // Determine start node
  const startNode = findStartNode(nodes);

  // Run validation
  const validation = validateGraph(nodes, startNode, errors, warnings);

  return {
    id: storyId,
    title: title || 'Imported Story',
    nodes,
    startNode,
    validation,
  };
}

/**
 * Extract all text from an ink content array recursively
 */
function extractText(content: unknown[]): string {
  let text = '';
  for (const item of content) {
    if (typeof item === 'string' && item.startsWith('^')) {
      text += item.substring(1);
    } else if (Array.isArray(item)) {
      text += extractText(item);
    } else if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      // Check for 's' key which contains choice display text
      if ('s' in obj && Array.isArray(obj['s'])) {
        text += extractText(obj['s'] as unknown[]);
      }
    }
  }
  return text;
}

/**
 * Find all diverts in content, resolving relative paths
 */
function findDiverts(content: unknown[], currentKnot?: string): string[] {
  const diverts: string[] = [];
  for (const item of content) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      if ('->' in obj) {
        const target = obj['->'] as string;
        // Skip variable references
        if (target.includes('$')) {
          continue;
        }
        // Handle relative paths like .^.^.^.stitch_name
        if (target.startsWith('.')) {
          // Extract the final component (stitch name)
          const parts = target.split('.');
          const lastPart = parts[parts.length - 1];
          if (lastPart && !lastPart.startsWith('^') && lastPart !== 's') {
            // This is a relative reference to a stitch
            if (currentKnot) {
              diverts.push(`${currentKnot}.${lastPart}`);
            } else {
              diverts.push(lastPart);
            }
          }
        } else if (!target.startsWith('0.')) {
          // Absolute reference
          diverts.push(target);
        }
      }
    } else if (Array.isArray(item)) {
      diverts.push(...findDiverts(item, currentKnot));
    }
  }
  return diverts;
}

/**
 * Parse knot/stitch content into a StoryNode
 */
function parseKnotContent(id: string, content: unknown[], parent: string | null): StoryNode {
  const node: StoryNode = {
    id,
    type: 'knot',
    parent,
    content: [],
    choices: [],
    divert: null,
    tags: [],
    lineNumber: 0,
  };

  // Track choice definitions and their text
  const choiceTexts: string[] = [];

  // First pass: collect choice text by looking for pattern:
  // ev -> str -> ^TEXT -> /str -> /ev -> {*: target}
  let currentText = '';
  let inEval = false;
  let inString = false;
  let evalText = '';

  for (let i = 0; i < content.length; i++) {
    const item = content[i];

    if (typeof item === 'string') {
      if (item === 'ev') {
        inEval = true;
        evalText = '';
        continue;
      }
      if (item === '/ev') {
        inEval = false;
        continue;
      }
      if (item === 'str') {
        inString = true;
        continue;
      }
      if (item === '/str') {
        inString = false;
        continue;
      }
      if (item === '\n') {
        if (currentText.trim() && !inEval) {
          node.content.push({ text: currentText.trim(), tags: [] });
          currentText = '';
        }
        continue;
      }
      if (item === 'end' || item === 'done') {
        continue;
      }

      // Text content starts with ^
      if (item.startsWith('^')) {
        const text = item.substring(1);
        if (inEval && inString) {
          // This is choice text (inside ev/str)
          evalText += text;
        } else if (!inEval) {
          // Regular narrative text
          currentText += text;
        }
      }
    } else if (Array.isArray(item)) {
      // Complex choice definition array - may contain:
      // 1. The choice marker {*: target} AND the text {s: [text]}
      // 2. Or just preliminary content before a choice marker
      let hasChoiceMarker = false;
      let foundChoiceText = '';

      for (const sub of item) {
        if (typeof sub === 'object' && sub !== null) {
          // Check for choice marker inside array
          if ('*' in sub) {
            hasChoiceMarker = true;
          }
          // Check for 's' key containing choice display text
          if ('s' in sub) {
            const sContent = (sub as Record<string, unknown>)['s'];
            if (Array.isArray(sContent)) {
              foundChoiceText = extractText(sContent);
            }
          }
        }
      }

      // If this array contains a choice marker with text, save it
      if (hasChoiceMarker && foundChoiceText.trim()) {
        choiceTexts.push(foundChoiceText.trim());
      } else {
        // Check if this array is followed by a choice marker
        const nextItem = content[i + 1];
        if (typeof nextItem === 'object' && nextItem !== null && '*' in nextItem) {
          // Try extracting text from the whole array
          const arrayText = extractText(item);
          if (arrayText.trim()) {
            choiceTexts.push(arrayText.trim());
          }
        }
      }
    } else if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;

      // Choice marker - save the evalText we collected
      if ('*' in obj) {
        if (evalText.trim()) {
          choiceTexts.push(evalText.trim());
          evalText = '';
        }
      }

      // Standalone divert (not inside choice)
      if ('->' in obj) {
        const target = obj['->'] as string;
        if (
          !target.startsWith('.') &&
          !target.startsWith('0.') &&
          !target.includes('$') &&
          !node.divert
        ) {
          node.divert = target;
        }
      }

      // Tags
      if ('#' in obj) {
        const tag = obj['#'] as string;
        node.tags.push(tag);
      }

      // Choice containers (c-0, c-1, etc.)
      for (const [key, value] of Object.entries(obj)) {
        if (key.startsWith('c-') && Array.isArray(value)) {
          const choiceNum = parseInt(key.substring(2), 10);
          const choiceContent = value as unknown[];

          // Get choice text from our collected texts
          const choiceText = choiceTexts[choiceNum] || '';

          // Find divert target in choice content
          // Pass the knot name for resolving relative paths to stitches
          const knotName = id.includes('.') ? id.split('.')[0] : id;
          const diverts = findDiverts(choiceContent, knotName);
          const choiceDivert =
            diverts.find((d) => d !== 'END' && d !== 'DONE') ||
            (choiceContent.some((c) => c === 'end' || c === 'done') ? 'END' : '');

          node.choices.push({
            text: choiceText || `Choice ${choiceNum + 1}`,
            target: choiceDivert || 'END',
            sticky: false,
            fallback: false,
            tags: [],
          });
        }
      }
    }
  }

  // Add any remaining text
  if (currentText.trim()) {
    node.content.push({ text: currentText.trim(), tags: [] });
  }

  return node;
}

/**
 * Find the start node of the story
 */
function findStartNode(nodes: Record<string, StoryNode>): string {
  // Check for intro node first
  if (nodes['_intro']) {
    return '_intro';
  }

  // Look for a knot named "start"
  if (nodes['start']) {
    return 'start';
  }

  // Otherwise, use the first knot
  const knots = Object.values(nodes).filter((n) => n.type === 'knot');
  if (knots.length > 0) {
    return knots[0].id;
  }

  return '';
}

/**
 * Validate the story graph
 */
function validateGraph(
  nodes: Record<string, StoryNode>,
  startNode: string,
  existingErrors: ValidationMessage[],
  existingWarnings: ValidationMessage[],
): ValidationResult {
  const errors: ValidationMessage[] = [...existingErrors];
  const warnings: ValidationMessage[] = [...existingWarnings];

  if (!startNode || !nodes[startNode]) {
    errors.push({
      type: 'missing_start',
      message: 'No start node found',
    });
  }

  // Check for missing divert targets
  const allTargets = new Set<string>();
  Object.values(nodes).forEach((node) => {
    if (node.divert && node.divert !== 'END' && node.divert !== 'DONE') {
      allTargets.add(node.divert);
    }
    node.choices.forEach((choice) => {
      if (choice.target && choice.target !== 'END' && choice.target !== 'DONE') {
        allTargets.add(choice.target);
      }
    });
  });

  allTargets.forEach((target) => {
    if (!nodes[target]) {
      // Try relative path resolution
      const matches = Object.keys(nodes).filter((id) => id === target || id.endsWith(`.${target}`));
      if (matches.length === 0) {
        warnings.push({
          type: 'missing_target',
          message: `Divert target "${target}" not found`,
        });
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
