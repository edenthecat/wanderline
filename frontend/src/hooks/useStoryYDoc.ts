// thin reader/writer accessors over the
// collaborative Y.Doc. Story tab callers reach a specific node's
// choice text Y.Text via getChoiceText(doc, nodeId, choiceIndex)
// without having to know the Y.Map shape. Phase 6 extends this
// with audio assignments + metadata accessors.
//
// Why expose this as a tiny helper rather than wiring the whole
// storyGraph through useYjs: the existing StoryTab already
// receives a full `storyGraph` JSON via fetchProject and renders
// off that. Phase 3 only changes how *editing* a choice text
// flows — read continues via the JSON snapshot until phase 6
// rebinds the rest. Keeps the diff small + the failure surface
// bounded.

import { useEffect, useState } from 'react';
import * as Y from 'yjs';

const NODES_KEY = 'nodes';

/**
 * Returns true once the collaborative Y.Doc's `nodes` map contains
 * any entries — i.e. the server-side seed has been received over
 * the WebSocket. React renders happen before that arrives, so
 * components that read Y.Text references out of the Doc need to
 * gate on this; otherwise their first render sees an empty map,
 * picks the REST-fallback path, and never re-renders to flip back
 * to the collaborative input even after the doc populates.
 */
export function useYjsSeedReady(doc: Y.Doc | null): boolean {
  const [ready, setReady] = useState<boolean>(() => {
    if (!doc) return false;
    return doc.getMap(NODES_KEY).size > 0;
  });
  useEffect(() => {
    if (!doc) {
      setReady(false);
      return;
    }
    const nodes = doc.getMap<Y.Map<unknown>>(NODES_KEY);
    if (nodes.size > 0) {
      setReady(true);
      return;
    }
    const handler = () => {
      if (nodes.size > 0) {
        setReady(true);
        nodes.unobserve(handler);
      }
    };
    nodes.observe(handler);
    return () => nodes.unobserve(handler);
  }, [doc]);
  return ready;
}

export function getChoiceText(
  doc: Y.Doc | null,
  nodeId: string,
  choiceIndex: number,
): Y.Text | null {
  if (!doc) return null;
  const nodes = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodes.get(nodeId);
  if (!node) return null;
  const choices = node.get('choices') as Y.Array<Y.Map<unknown>> | undefined;
  if (!choices) return null;
  const ch = choices.get(choiceIndex);
  if (!ch) return null;
  const text = ch.get('text');
  return text instanceof Y.Text ? text : null;
}

/** Y.Text for a node's content line. Y.Doc seed already mirrors
 * content as Y.Array<Y.Map{text: Y.Text, tags: Y.Array<string>}>;
 * this accessor walks it the same way getChoiceText does. */
export function getContentText(
  doc: Y.Doc | null,
  nodeId: string,
  contentIndex: number,
): Y.Text | null {
  if (!doc) return null;
  const nodes = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodes.get(nodeId);
  if (!node) return null;
  const content = node.get('content') as Y.Array<Y.Map<unknown>> | undefined;
  if (!content) return null;
  const line = content.get(contentIndex);
  if (!line) return null;
  const text = line.get('text');
  return text instanceof Y.Text ? text : null;
}
