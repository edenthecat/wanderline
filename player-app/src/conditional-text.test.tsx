import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App, { nodeText, conditionAllows } from './App';

// Variable support (DEV-199), Phase 3: Ink's `{condition: text}`
// conditional text. The parser side (ink-parser.ts) is covered on the
// backend; this file covers the player's side of the same contract —
// a text block whose condition doesn't hold against the current
// variable store must not appear in the rendered or spoken passage.

describe('conditionAllows', () => {
  it('always shows a block with no condition', () => {
    expect(conditionAllows(undefined, {})).toBe(true);
    expect(conditionAllows(null, {})).toBe(true);
  });

  it('shows or hides based on the evaluated condition', () => {
    const condition = {
      kind: 'binary' as const,
      operator: '>' as const,
      left: { kind: 'variable' as const, name: 'gold' },
      right: { kind: 'literal' as const, value: 10 },
    };
    expect(conditionAllows(condition, { gold: 20 })).toBe(true);
    expect(conditionAllows(condition, { gold: 5 })).toBe(false);
  });

  it('hides (does not throw) when the condition references an undeclared variable', () => {
    expect(conditionAllows({ kind: 'variable', name: 'never_declared' }, {})).toBe(false);
  });
});

describe('nodeText with conditional blocks', () => {
  it('omits a false-condition block and includes a true one', () => {
    const node = {
      content: [
        { kind: 'text' as const, text: 'Always shown.', tags: [] },
        {
          kind: 'text' as const,
          text: 'Only if rich.',
          tags: [],
          condition: {
            kind: 'binary' as const,
            operator: '>' as const,
            left: { kind: 'variable' as const, name: 'gold' },
            right: { kind: 'literal' as const, value: 10 },
          },
        },
      ],
    };
    expect(nodeText(node, { gold: 5 })).toBe('Always shown.');
    expect(nodeText(node, { gold: 20 })).toBe('Always shown. Only if rich.');
  });

  it('defaults to an empty variable store when none is passed', () => {
    const node = {
      content: [
        {
          kind: 'text' as const,
          text: 'Hidden.',
          tags: [],
          condition: { kind: 'variable' as const, name: 'never_declared' },
        },
      ],
    };
    expect(nodeText(node)).toBe('');
  });

  it('an explicit transcript override still wins over conditional content', () => {
    const node = {
      content: [
        {
          kind: 'text' as const,
          text: 'Conditional.',
          tags: [],
          condition: { kind: 'literal' as const, value: false },
        },
      ],
      metadata: { transcript: 'The override.' },
    };
    expect(nodeText(node, {})).toBe('The override.');
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
const STORY_ID = 'conditional-text-test';

function makeStory() {
  return {
    id: STORY_ID,
    title: 'Conditional Text Test',
    audioBaseUrl: './audio/',
    startNode: 'start',
    variables: [
      { name: 'gold', type: 'number', initialValue: { kind: 'literal', value: 0 }, isConst: false },
    ],
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [{ kind: 'text', text: 'Welcome.', tags: [] }],
        choices: [{ text: 'Onward', target: 'second' }],
        divert: null,
        tags: [],
      },
      second: {
        id: 'second',
        type: 'knot',
        content: [
          {
            kind: 'assignment',
            statement: {
              kind: 'assignment',
              name: 'gold',
              operator: '+=',
              value: { kind: 'literal', value: 20 },
            },
          },
          { kind: 'text', text: 'You found some gold.', tags: [] },
          {
            kind: 'text',
            text: 'You feel rich.',
            tags: [],
            condition: {
              kind: 'binary',
              operator: '>',
              left: { kind: 'variable', name: 'gold' },
              right: { kind: 'literal', value: 10 },
            },
          },
          {
            kind: 'text',
            text: 'You feel broke.',
            tags: [],
            condition: {
              kind: 'binary',
              operator: '<=',
              left: { kind: 'variable', name: 'gold' },
              right: { kind: 'literal', value: 10 },
            },
          },
        ],
        choices: [],
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

describe('conditional text — integration', () => {
  it('renders the true-condition block and omits the false one, after the node’s own assignment runs', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    // The node's own `gold += 20` must have already run (0 -> 20)
    // before conditions on its own content are evaluated, so the
    // true branch (gold > 10) is what shows.
    await screen.findByText('You feel rich.');
    expect(screen.queryByText('You feel broke.')).toBeNull();
  });
});
