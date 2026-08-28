import { fallThroughTarget } from './fall-through';

// Ordering for the "Download for offline" file list.
//
// The list used to be built by iterating Object.values(story.nodes),
// i.e. whatever order the nodes happen to sit in the story graph. That
// is fine when a download completes and useless when it doesn't: an
// interrupted run — quota exhausted, signal lost on the way into a
// tunnel, tab closed — left a random scattering of the story on the
// device. Chapter 1, chapter 7, half of chapter 3.
//
// Ordering breadth-first from the start node instead means a partial
// download is a playable *prefix*. You get the opening of the story
// and a clean edge where it stops, which is a degraded experience
// rather than a broken one, and it's what makes "48 of 60 saved"
// meaningful rather than merely true.
//
// Structural types: App.tsx declares its own StoryData/StoryNode
// locally (they carry per-choice indicator audio that types.ts doesn't
// model), so this takes the narrowest shape it actually needs rather
// than importing either.

export interface OrderableNode {
  // Needed for Ink's implicit continuation — see the walk below.
  id?: string;
  type?: string;
  parent?: string | null;
  lineNumber?: number;
  choices?: Array<{ target?: string }>;
  divert?: string | null;
  audio?: {
    voiceover?: string;
    ambience?: string;
    choice1?: string;
    choice2?: string;
  };
}

export interface OrderableStory {
  nodes: Record<string, OrderableNode>;
  startNode: string;
  audioBaseUrl: string;
  backgroundMusic?: string[];
  indicatorAudio?: { choice1?: string; choice2?: string };
}

// Terminal divert targets that aren't real nodes.
const TERMINAL_TARGETS = new Set(['END', 'DONE']);

/**
 * Node ids breadth-first from `startNode`, so index order tracks
 * distance into the story. Nodes the graph can't reach are appended
 * afterwards in declaration order — they're usually authoring debris,
 * but a reader can still land on one via a save slot, so they're worth
 * downloading last rather than not at all.
 */
export function orderNodesByReachability(story: OrderableStory): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [story.startNode];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id) || !story.nodes[id]) continue;
    seen.add(id);
    ordered.push(id);

    const node = story.nodes[id];
    for (const choice of node.choices ?? []) {
      const target = choice.target;
      if (target && !TERMINAL_TARGETS.has(target)) queue.push(target);
    }
    if (node.divert && !TERMINAL_TARGETS.has(node.divert)) queue.push(node.divert);
    // Ink's implicit continuation is a real playback edge, so it has to
    // be a real edge here too. Without it every stitch after a knot's
    // first is unreachable by this walk and lands in the tail below —
    // so an interrupted download of a story written as multi-stitch
    // chapters saves each chapter's opening and nothing after it, which
    // is the opposite of the playable prefix this ordering promises.
    const onward = fallThroughTarget(id, node, story.nodes);
    if (onward) queue.push(onward);
  }

  for (const id of Object.keys(story.nodes)) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

/**
 * Every audio URL the story references, ordered so that downloading
 * the list front-to-back keeps the device useful at every point.
 *
 * Indicators and the first music track come first: they're small, and
 * they're used on every single choice, so a story that has the
 * chapters but not the cues feels broken in a way that's worse than
 * simply having fewer chapters.
 *
 * Duplicates are dropped on first occurrence, which keeps a file
 * shared between an early and a late node in its earliest position.
 */
export function orderAudioUrlsForDownload(story: OrderableStory | null): string[] {
  if (!story) return [];
  const base = story.audioBaseUrl.replace(/\/?$/, '/');
  const urls = new Set<string>();

  if (story.indicatorAudio?.choice1) urls.add(base + story.indicatorAudio.choice1);
  if (story.indicatorAudio?.choice2) urls.add(base + story.indicatorAudio.choice2);
  const [firstTrack, ...restTracks] = story.backgroundMusic ?? [];
  if (firstTrack) urls.add(base + firstTrack);

  for (const nodeId of orderNodesByReachability(story)) {
    const audio = story.nodes[nodeId]?.audio;
    if (!audio) continue;
    // Voiceover before cues: it's the thing the listener is actually
    // here for, and it's the larger file.
    if (audio.voiceover) urls.add(base + audio.voiceover);
    if (audio.choice1) urls.add(base + audio.choice1);
    if (audio.choice2) urls.add(base + audio.choice2);
    if (audio.ambience) urls.add(base + audio.ambience);
  }

  // Remaining music last: pleasant, but a story missing its later
  // backing tracks still plays through.
  for (const track of restTracks) urls.add(base + track);

  return [...urls];
}
