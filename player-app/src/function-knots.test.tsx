import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App, {
  storyFunctionCaller,
  applyNodeAssignments,
  conditionAllows,
  initialVariableValues,
} from './App';
import { evaluate, type Expression } from '@wanderline/shared';

// Function-knots (DEV-199 Phase 10b): real playback must run a
// `{myFunc(x)}` call identically to backend validation — the same
// `createFunctionCaller` shared implementation, just pointed at the
// player's own node shape via `storyFunctionCaller` (App.tsx). Pure-
// function coverage here mirrors variables.test.tsx's split: direct
// coverage of the helper, plus an integration pass through a real
// App render (window.__WANDERLINE_STORY__), since that's the thing
// actually at risk of a wiring mistake (a call site that forgot to
// pass `callFunction` through).

class MockAudio {
  src: string;
  paused = true;
  currentTime = 0;
  duration = 0;
  volume = 1;
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
const STORY_ID = 'function-knot-test';

function makeFunctionKnotStory() {
  return {
    id: STORY_ID,
    title: 'Function Knot Test',
    audioBaseUrl: './audio/',
    // Note: `start` (the node that actually doubles gold and gates a
    // choice on it) is reached via ONE click from this `intro` node,
    // not entered as the story's own startNode — the start node's
    // own assignments run through freshStartVariables at LOAD time,
    // before any autosave write (navigateToNode is what writes the
    // autosave), so a test that wants to observe the write has to
    // navigate at least once first. Same shape variables.test.tsx
    // uses for its own assignment-persistence test.
    startNode: 'intro',
    variables: [
      { name: 'gold', type: 'number', initialValue: { kind: 'literal', value: 3 }, isConst: false },
    ],
    nodes: {
      intro: {
        id: 'intro',
        type: 'knot',
        content: [{ kind: 'text', text: 'The beginning.', tags: [] }],
        choices: [{ text: 'Onward', target: 'start' }],
        divert: null,
        tags: [],
      },
      double: {
        id: 'double',
        type: 'knot',
        content: [
          {
            kind: 'assignment',
            statement: {
              kind: 'return',
              value: {
                kind: 'binary',
                operator: '*',
                left: { kind: 'variable', name: 'x' },
                right: { kind: 'literal', value: 2 },
              },
            },
          },
        ],
        choices: [],
        divert: null,
        tags: ['internal:function'],
        params: ['x'],
      },
      start: {
        id: 'start',
        type: 'knot',
        content: [
          {
            kind: 'assignment',
            statement: {
              kind: 'assignment',
              name: 'gold',
              operator: '=',
              value: {
                kind: 'call',
                name: 'double',
                args: [{ kind: 'variable', name: 'gold' }],
              },
            },
          },
          { kind: 'text', text: 'Gold doubled.', tags: [] },
        ],
        choices: [
          {
            text: 'Big spender',
            target: 'richEnding',
            condition: {
              kind: 'binary',
              operator: '>',
              left: { kind: 'call', name: 'double', args: [{ kind: 'variable', name: 'gold' }] },
              right: { kind: 'literal', value: 10 },
            },
          },
          { text: 'Leave', target: 'poorEnding' },
        ],
        divert: null,
        tags: [],
      },
      richEnding: {
        id: 'richEnding',
        type: 'knot',
        content: [{ kind: 'text', text: 'You are rich.', tags: [] }],
        choices: [],
        divert: 'END',
        tags: [],
      },
      poorEnding: {
        id: 'poorEnding',
        type: 'knot',
        content: [{ kind: 'text', text: 'You left.', tags: [] }],
        choices: [],
        divert: 'END',
        tags: [],
      },
    },
  };
}

function readAutosave(): { variables?: Record<string, unknown> } | undefined {
  const raw = localStorage.getItem(`wanderline_${STORY_ID}_slots`);
  if (!raw) return undefined;
  const slots = JSON.parse(raw) as Array<{ id: string; variables?: Record<string, unknown> }>;
  return slots.find((s) => s.id === 'autosave');
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

describe('storyFunctionCaller', () => {
  const story = makeFunctionKnotStory();

  it('runs a real function-knot node and returns its value', () => {
    const caller = storyFunctionCaller(story.nodes);
    const expr: Expression = {
      kind: 'call',
      name: 'double',
      args: [{ kind: 'literal', value: 5 }],
    };
    expect(evaluate(expr, {}, caller)).toBe(10);
  });

  it('does not treat an ordinary (non-function) knot as callable', () => {
    const caller = storyFunctionCaller(story.nodes);
    const expr: Expression = { kind: 'call', name: 'start', args: [] };
    expect(() => evaluate(expr, {}, caller)).toThrow(/undeclared/);
  });

  it('conditionAllows evaluates a condition containing a function call', () => {
    const caller = storyFunctionCaller(story.nodes);
    const condition: Expression = {
      kind: 'binary',
      operator: '>',
      left: { kind: 'call', name: 'double', args: [{ kind: 'variable', name: 'gold' }] },
      right: { kind: 'literal', value: 10 },
    };
    expect(conditionAllows(condition, { gold: 3 }, caller)).toBe(false);
    expect(conditionAllows(condition, { gold: 10 }, caller)).toBe(true);
  });

  it('applyNodeAssignments runs a function call in an assignment and persists the result', () => {
    const caller = storyFunctionCaller(story.nodes);
    const next = applyNodeAssignments(story.nodes.start, { gold: 3 }, caller);
    expect(next.gold).toBe(6);
  });

  it('initialVariableValues accepts the optional callFunction without requiring it', () => {
    // VAR initializers never contain calls in practice (see
    // initialVariableValues' own doc comment) — this just confirms
    // passing the handler through doesn't break the ordinary path.
    const caller = storyFunctionCaller(story.nodes);
    expect(initialVariableValues(story.variables, caller)).toEqual({ gold: 3 });
  });
});

describe('function-knots — integration (real App render)', () => {
  it('a choice condition calling a function-knot gates visibility correctly', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeFunctionKnotStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    fireEvent.click(await screen.findByLabelText(/^Choice 1/)); // intro -> start
    await screen.findByText('Gold doubled.');
    // gold started at 3, doubled to 6 by the in-content assignment;
    // double(6) = 12 > 10, so "Big spender" must be visible.
    expect(await screen.findByLabelText(/^Choice 1/)).toHaveTextContent('Big spender');
    expect(screen.getByLabelText(/^Choice 2/)).toHaveTextContent('Leave');
  });

  it('persists the function call’s result through the in-content assignment', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeFunctionKnotStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    fireEvent.click(await screen.findByLabelText(/^Choice 1/)); // intro -> start
    await screen.findByText('Gold doubled.');
    expect(readAutosave()?.variables).toEqual({ gold: 6 });
  });

  it('choosing the gated choice navigates correctly once the condition is satisfied', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeFunctionKnotStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    fireEvent.click(await screen.findByLabelText(/^Choice 1/)); // intro -> start
    await screen.findByText('Gold doubled.');
    fireEvent.click(await screen.findByLabelText(/^Choice 1/)); // start -> richEnding
    await screen.findByText('You are rich.');
  });
});
