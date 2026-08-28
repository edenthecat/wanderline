// What the ⌘K palette can do, kept out of the component that draws it.
//
// A "provider" turns the current context (what's typed, the story
// we're in, and the verbs the host page can perform) into a flat list
// of commands. The palette renders whatever comes back and knows
// nothing about passages, flags, or tabs.
//
// Adding a verb later — "jump to flag", "jump to unreachable",
// "preview from here" — is: write a provider, add it to
// DEFAULT_PROVIDERS, and add whatever it needs to PaletteActions.
// No change to CommandPalette.tsx.

import type { StoryGraph } from '../api/client';
import { matchRank, nodeExcerpt, nodeMatchesQuery, normalizeQuery } from './nodeSearch';

/** The verbs the host page exposes to commands. */
export interface PaletteActions {
  /** Land the author on a passage, switching tabs if needed. */
  jumpToNode: (nodeId: string) => void;
}

export interface PaletteContext {
  /** Raw text the author has typed. Providers normalize it themselves. */
  query: string;
  storyGraph: StoryGraph | null;
  actions: PaletteActions;
}

export interface PaletteCommand {
  /** Stable within one build; used as the React key. */
  id: string;
  /** Heading this command sits under in the list. */
  group: string;
  /** Primary line. */
  label: string;
  /** Optional secondary line — an excerpt, a count, a target. */
  hint?: string;
  /** Lower sorts first within a group. */
  rank: number;
  run: () => void;
}

export type CommandProvider = (ctx: PaletteContext) => PaletteCommand[];

/** Rendering 500 rows for an empty query helps nobody, and the
 * listbox has to stay navigable one arrow key at a time. */
export const MAX_COMMANDS = 50;

export const PASSAGE_GROUP = 'Passages';

/**
 * Every passage in the story, filtered by the shared node-search rule
 * (see lib/nodeSearch) so the palette agrees with both tabs' search
 * boxes about what "matches" means.
 */
export const passageProvider: CommandProvider = ({ query, storyGraph, actions }) => {
  if (!storyGraph) return [];
  const q = normalizeQuery(query);
  const commands: PaletteCommand[] = [];
  for (const node of Object.values(storyGraph.nodes)) {
    if (!nodeMatchesQuery(node, q)) continue;
    commands.push({
      id: `jump-node:${node.id}`,
      group: PASSAGE_GROUP,
      label: node.id,
      hint: nodeExcerpt(node),
      rank: matchRank(node, q),
      run: () => actions.jumpToNode(node.id),
    });
  }
  return commands;
};

export const DEFAULT_PROVIDERS: readonly CommandProvider[] = [passageProvider];

export interface CommandBuildResult {
  /** What the palette should render, already ranked and capped. */
  commands: PaletteCommand[];
  /** How many matched before the cap — this is the count we announce. */
  totalCount: number;
  truncated: boolean;
}

/**
 * Run every provider, order the results, and cap the list.
 *
 * Groups stay contiguous and keep the order they were first produced
 * in, so a group heading is never repeated and the flat array IS the
 * render order (the palette's highlight index counts through it).
 * Within a group the sort is by rank — an id that starts with the
 * query beats a content-only hit — and otherwise stable, so providers
 * keep control of their own tie-breaking: passages stay in story order.
 */
export function buildCommands(
  ctx: PaletteContext,
  providers: readonly CommandProvider[] = DEFAULT_PROVIDERS,
  limit: number = MAX_COMMANDS,
): CommandBuildResult {
  const byGroup = new Map<string, PaletteCommand[]>();
  let totalCount = 0;
  for (const provider of providers) {
    for (const command of provider(ctx)) {
      const bucket = byGroup.get(command.group);
      if (bucket) bucket.push(command);
      else byGroup.set(command.group, [command]);
      totalCount += 1;
    }
  }
  const ordered: PaletteCommand[] = [];
  for (const bucket of byGroup.values()) {
    bucket.sort((a, b) => a.rank - b.rank);
    ordered.push(...bucket);
  }
  return {
    commands: ordered.slice(0, limit),
    totalCount,
    truncated: totalCount > limit,
  };
}
