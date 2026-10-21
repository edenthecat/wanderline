import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App, { initialVariableValues, applyNodeAssignments, freshStartVariables } from './App';

// Variable support (DEV-199), Phase 2: the player's variable store.
// Pure-function coverage lives alongside an integration pass that
// exercises the real App render — the thing Phase 1 was explicitly
// guarding against (an assignment block reaching the player with no
// one to run it) only shows up end-to-end.

describe('initialVariableValues', () => {
  it('evaluates each declaration in order, allowing later ones to reference earlier ones', () => {
    expect(
      initialVariableValues([
        { name: 'a', type: 'number', initialValue: { kind: 'literal', value: 5 }, isConst: false },
        {
          name: 'b',
          type: 'number',
          initialValue: {
            kind: 'binary',
            operator: '*',
            left: { kind: 'variable', name: 'a' },
            right: { kind: 'literal', value: 2 },
          },
          isConst: false,
        },
      ]),
    ).toEqual({ a: 5, b: 10 });
  });

  it('is an empty record for no declarations', () => {
    expect(initialVariableValues(undefined)).toEqual({});
  });

  it('skips a declaration whose initializer fails to evaluate rather than throwing', () => {
    expect(
      initialVariableValues([
        {
          name: 'broken',
          type: 'number',
          initialValue: { kind: 'variable', name: 'never_declared' },
          isConst: false,
        },
        { name: 'ok', type: 'number', initialValue: { kind: 'literal', value: 1 }, isConst: false },
      ]),
    ).toEqual({ ok: 1 });
  });
});

describe('applyNodeAssignments', () => {
  it('runs assignment blocks in order, leaving text blocks alone', () => {
    const node = {
      content: [
        { kind: 'text' as const, text: 'Before.', tags: [] },
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'gold',
            operator: '+=' as const,
            value: { kind: 'literal' as const, value: 10 },
          },
        },
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'gold',
            operator: '*=' as const,
            value: { kind: 'literal' as const, value: 2 },
          },
        },
      ],
    };
    expect(applyNodeAssignments(node, { gold: 5 })).toEqual({ gold: 30 });
  });

  it('is a no-op for a node with no assignment blocks', () => {
    const node = { content: [{ kind: 'text' as const, text: 'Hi.', tags: [] }] };
    expect(applyNodeAssignments(node, { gold: 5 })).toEqual({ gold: 5 });
  });

  it('returns the input unchanged for an undefined node', () => {
    expect(applyNodeAssignments(undefined, { gold: 5 })).toEqual({ gold: 5 });
  });

  it('skips a statement that fails (compound-assign to an undeclared name) rather than throwing', () => {
    const node = {
      content: [
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'never_declared',
            operator: '+=' as const,
            value: { kind: 'literal' as const, value: 1 },
          },
        },
      ],
    };
    expect(applyNodeAssignments(node, { gold: 5 })).toEqual({ gold: 5 });
  });
});

describe('freshStartVariables', () => {
  it('combines declared defaults with the start node’s own assignments', () => {
    const story = {
      startNode: 'start',
      variables: [
        {
          name: 'gold',
          type: 'number' as const,
          initialValue: { kind: 'literal' as const, value: 0 },
          isConst: false,
        },
      ],
      nodes: {
        start: {
          content: [
            {
              kind: 'assignment' as const,
              statement: {
                kind: 'assignment' as const,
                name: 'gold',
                operator: '+=' as const,
                value: { kind: 'literal' as const, value: 5 },
              },
            },
          ],
        },
      },
    };
    expect(freshStartVariables(story)).toEqual({ gold: 5 });
  });
});

// — integration: the real App render —

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
const STORY_ID = 'vars-test';

function makeVariableStory() {
  return {
    id: STORY_ID,
    title: 'Vars Test',
    audioBaseUrl: './audio/',
    startNode: 'start',
    variables: [
      { name: 'gold', type: 'number', initialValue: { kind: 'literal', value: 0 }, isConst: false },
    ],
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [{ kind: 'text', text: 'The beginning.', tags: [] }],
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
              value: { kind: 'literal', value: 10 },
            },
          },
          { kind: 'text', text: 'You found gold.', tags: [] },
        ],
        choices: [],
        divert: null,
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

describe('variable store — integration', () => {
  it('applies a node’s assignment block when navigating into it, and persists the result', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeVariableStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('You found gold.');
    expect(readAutosave()?.variables).toEqual({ gold: 10 });
  });

  it('does not render a stray "undefined" for the assignment block alongside the narration', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeVariableStory();
    const { container } = render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('You found gold.');
    expect(container.textContent).not.toContain('undefined');
  });

  it('resumes from a saved variable snapshot rather than replaying the resumed node', async () => {
    localStorage.setItem(
      `wanderline_${STORY_ID}_slots`,
      JSON.stringify([
        {
          id: 'autosave',
          name: 'Autosave',
          nodeId: 'second',
          history: ['start'],
          variables: { gold: 999 },
          savedAt: new Date().toISOString(),
        },
      ]),
    );
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeVariableStory();
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    await screen.findByText('You found gold.');
    // 999, not 1009 — the resumed node's `+= 10` must not re-fire.
    expect(readAutosave()?.variables).toEqual({ gold: 999 });
  });
});
