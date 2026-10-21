import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, createEvent } from '@testing-library/react';
import App, { autoAdvanceTarget } from './App';

// Variable support (DEV-199), Phase 4: Ink's `{condition}` choice
// prefix gating a choice's visibility. The parser side is covered on
// the backend (ink-parser.test.ts); this file covers the player's
// side of the same contract — a false-condition choice must neither
// render nor be selectable, by click or by keyboard.

describe('autoAdvanceTarget with conditional choices', () => {
  const node = {
    id: 'start',
    choices: [
      {
        target: 'locked',
        condition: {
          kind: 'binary' as const,
          operator: '>' as const,
          left: { kind: 'variable' as const, name: 'gold' },
          right: { kind: 'literal' as const, value: 10 },
        },
      },
      { target: 'open' },
    ],
    divert: null,
  };

  it('treats a node with one hidden and one visible choice as exactly one way forward', () => {
    expect(autoAdvanceTarget(node, { autoAdvance: true }, undefined, { gold: 0 })).toBe('open');
  });

  it('does not auto-advance when both choices are visible (a real decision)', () => {
    expect(autoAdvanceTarget(node, { autoAdvance: true }, undefined, { gold: 20 })).toBeNull();
  });
});

// — integration —

class MockAudio {
  src = '';
  preload = '';
  volume = 1;
  loop = false;
  paused = true;
  currentTime = 0;
  duration = 0;
  oncanplaythrough: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onpause: (() => void) | null = null;
  constructor(src?: string) {
    this.src = src ?? '';
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

const originalAudio = globalThis.Audio;
const STORY_ID = 'conditional-choices-test';

function makeStory() {
  return {
    id: STORY_ID,
    title: 'Conditional Choices Test',
    audioBaseUrl: './audio/',
    startNode: 'start',
    variables: [
      { name: 'gold', type: 'number', initialValue: { kind: 'literal', value: 0 }, isConst: false },
    ],
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [{ kind: 'text', text: 'Question?', tags: [] }],
        choices: [
          {
            text: 'Buy the sword',
            target: 'sword',
            condition: {
              kind: 'binary',
              operator: '>',
              left: { kind: 'variable', name: 'gold' },
              right: { kind: 'literal', value: 10 },
            },
          },
          { text: 'Leave', target: 'END' },
        ],
        divert: null,
        tags: [],
      },
      sword: {
        id: 'sword',
        type: 'knot',
        content: [{ kind: 'text', text: 'You bought the sword.', tags: [] }],
        choices: [],
        divert: 'END',
        tags: [],
      },
    },
  };
}

function makeAllHiddenStory() {
  return {
    id: STORY_ID,
    title: 'All Hidden Test',
    audioBaseUrl: './audio/',
    startNode: 'start',
    variables: [],
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [{ kind: 'text', text: 'Nothing to do.', tags: [] }],
        choices: [
          {
            text: 'Impossible',
            target: 'END',
            condition: { kind: 'literal', value: false },
          },
        ],
        divert: null,
        tags: [],
      },
    },
  };
}

beforeEach(() => {
  globalThis.Audio = MockAudio as unknown as typeof Audio;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.Audio = originalAudio;
  delete (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__;
});

describe('conditional choices — integration', () => {
  it('a false-condition choice does not render', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    await screen.findByText('Question?');
    expect(screen.queryByLabelText(/Buy the sword/)).toBeNull();
    expect(screen.getByLabelText(/^Choice 1/)).toHaveTextContent('Leave');
    // Only the one visible choice renders — not two buttons with one hidden via CSS.
    expect(screen.getAllByRole('button', { name: /^Choice \d/ })).toHaveLength(1);
  });

  it('a true-condition choice renders and is clickable', async () => {
    const story = makeStory();
    // Start already rich enough to see the gated choice.
    story.variables[0].initialValue = { kind: 'literal', value: 20 };
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = story;
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    await screen.findByText('Question?');
    expect(screen.getAllByRole('button', { name: /^Choice \d/ })).toHaveLength(2);
    fireEvent.click(screen.getByLabelText(/Buy the sword/));
    await screen.findByText('You bought the sword.');
  });

  it('a node whose only choice is always hidden is treated as an ending, not left stuck with no controls', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeAllHiddenStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    await screen.findByText('Nothing to do.');
    expect(screen.queryByRole('button', { name: /^Choice \d/ })).toBeNull();
    await screen.findByText(/The End/i);
  });
});

describe('selected-choice index stays valid when the choice count changes', () => {
  const VARYING_STORY_ID = 'varying-choice-count-test';

  function makeVaryingChoiceStory() {
    return {
      id: VARYING_STORY_ID,
      title: 'Varying Choice Count',
      audioBaseUrl: './audio/',
      startNode: 'start',
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [{ kind: 'text', text: 'Pick one.', tags: [] }],
          choices: [
            { text: 'First', target: 'a' },
            { text: 'Second', target: 'b' },
          ],
          divert: null,
          tags: [],
        },
        a: {
          id: 'a',
          type: 'knot',
          content: [{ kind: 'text', text: 'A.', tags: [] }],
          choices: [],
          divert: 'END',
          tags: [],
        },
        b: {
          id: 'b',
          type: 'knot',
          content: [{ kind: 'text', text: 'B.', tags: [] }],
          choices: [{ text: 'Only', target: 'c' }],
          divert: null,
          tags: [],
        },
        c: {
          id: 'c',
          type: 'knot',
          content: [{ kind: 'text', text: 'C.', tags: [] }],
          choices: [],
          divert: 'END',
          tags: [],
        },
      },
    };
  }

  it('loadSlot resets the selected index, so Enter still works on a node with fewer choices', async () => {
    localStorage.setItem(
      `wanderline_${VARYING_STORY_ID}_slots`,
      JSON.stringify([
        {
          id: 'manual-1',
          name: 'Save 1',
          nodeId: 'b',
          history: ['start'],
          variables: {},
          savedAt: new Date().toISOString(),
        },
      ]),
    );
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeVaryingChoiceStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    await screen.findByText('Pick one.');
    // Arm the SECOND of the start node's two choices.
    fireEvent(
      document.body,
      createEvent.keyDown(document.body, { key: 'ArrowDown', bubbles: true }),
    );
    // Load the manual slot — node 'b' has only ONE choice. If the
    // armed index weren't reset, it would still point at index 1,
    // which doesn't exist on 'b', and Enter below would do nothing.
    fireEvent.click(await screen.findByLabelText('Settings'));
    fireEvent.click(await screen.findByRole('button', { name: 'Load' }));
    await screen.findByText('B.');
    fireEvent(document.body, createEvent.keyDown(document.body, { key: 'Enter', bubbles: true }));
    await screen.findByText('C.');
  });
});
