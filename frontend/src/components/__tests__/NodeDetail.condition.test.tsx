import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NodeDetail from '../NodeDetail';

// DEV-199 Phase 5: free-text condition editing for choices and text
// blocks, plus a read-only preview for assignment blocks.

vi.mock('../CollabChoiceTextInput', () => ({ default: () => null }));
vi.mock('../CollabContentTextarea', () => ({ default: () => null }));

function props(over: Record<string, unknown> = {}) {
  return {
    nodeId: 'her',
    node: {
      content: [{ kind: 'text', text: 'Hi.', tags: [] }],
      choices: [{ text: 'Go', target: 'there' }],
      divert: null,
      tags: [],
    },
    metadataLoaded: true,
    nodeIdSet: new Set(['her', 'there']),
    nodeIdOptions: null,
    projectId: 'p1',
    onChoiceTextEdit: vi.fn(),
    onContentEdit: vi.fn(),
    onChoiceTargetEdit: vi.fn(),
    onDivertEdit: vi.fn(),
    onAddChoice: vi.fn(),
    onDeleteChoice: vi.fn(),
    onSwapChoices: vi.fn(),
    onMetadataSave: vi.fn().mockResolvedValue(undefined),
    yDoc: null,
    yDocReady: false,
    ...over,
  } as unknown as React.ComponentProps<typeof NodeDetail>;
}

describe('NodeDetail — choice condition', () => {
  it('hides the condition affordance when no handler is given', () => {
    render(<NodeDetail {...props()} />);
    expect(screen.queryByText('+ Condition')).toBeNull();
  });

  it('shows "+ Condition" for an unconditioned choice, and the badge once set', () => {
    render(
      <NodeDetail
        {...props({
          node: {
            content: [],
            choices: [
              {
                text: 'Go',
                target: 'there',
                condition: {
                  kind: 'binary',
                  operator: '>',
                  left: { kind: 'variable', name: 'gold' },
                  right: { kind: 'literal', value: 10 },
                },
              },
            ],
            divert: null,
            tags: [],
          },
          onChoiceConditionEdit: vi.fn(),
        })}
      />,
    );
    expect(screen.getByText('if gold > 10')).toBeTruthy();
    expect(screen.getByText('Edit condition')).toBeTruthy();
  });

  it('parses the typed condition and calls onChoiceConditionEdit with the source text', async () => {
    const onChoiceConditionEdit = vi.fn().mockResolvedValue(undefined);
    render(<NodeDetail {...props({ onChoiceConditionEdit })} />);

    fireEvent.click(screen.getByText('+ Condition'));
    const input = screen.getByLabelText('Choice 1 condition on her');
    fireEvent.change(input, { target: { value: 'gold > 10' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onChoiceConditionEdit).toHaveBeenCalledWith(0, 'gold > 10');
    });
  });

  it('shows a parse error inline and does not call the handler', async () => {
    const onChoiceConditionEdit = vi.fn();
    render(<NodeDetail {...props({ onChoiceConditionEdit })} />);

    fireEvent.click(screen.getByText('+ Condition'));
    fireEvent.change(screen.getByLabelText('Choice 1 condition on her'), {
      target: { value: 'gold >>' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onChoiceConditionEdit).not.toHaveBeenCalled();
    });
  });

  it('clears the condition by calling the handler with null', async () => {
    const onChoiceConditionEdit = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeDetail
        {...props({
          node: {
            content: [],
            choices: [{ text: 'Go', target: 'there', condition: { kind: 'literal', value: true } }],
            divert: null,
            tags: [],
          },
          onChoiceConditionEdit,
        })}
      />,
    );

    fireEvent.click(screen.getByText('Edit condition'));
    fireEvent.click(screen.getByText('Clear'));

    await waitFor(() => {
      expect(onChoiceConditionEdit).toHaveBeenCalledWith(0, null);
    });
  });
});

describe('NodeDetail — text block condition', () => {
  it('shows the condition editor affordance next to a text block when a handler is given', () => {
    render(<NodeDetail {...props({ onContentConditionEdit: vi.fn() })} />);
    expect(screen.getByText('+ Condition')).toBeTruthy();
  });

  it('calls onContentConditionEdit with the typed condition text', async () => {
    const onContentConditionEdit = vi.fn().mockResolvedValue(undefined);
    render(<NodeDetail {...props({ onContentConditionEdit })} />);

    fireEvent.click(screen.getByText('+ Condition'));
    fireEvent.change(screen.getByLabelText('Content line 1 condition on her'), {
      target: { value: 'seenIntro == true' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onContentConditionEdit).toHaveBeenCalledWith(0, 'seenIntro == true');
    });
  });
});

// A LIST member reference only resolves correctly if NodeDetail
// threads the project's LIST declarations into ConditionEditor's own
// validation parse — without it, a multi-member literal like
// `(cold, boiling)` doesn't parse as a list literal at all (it's not
// valid syntax for a plain sub-expression either), so a real LIST
// condition gets rejected by client-side validation that never even
// reaches the server (found in review).
describe('NodeDetail — LIST-aware condition validation', () => {
  const kettleStateVariable = {
    name: 'kettleState',
    type: 'list' as const,
    isConst: false,
    listMembers: ['cold', 'boiling'],
    initialValue: {
      kind: 'literal' as const,
      value: { kind: 'list' as const, origin: 'kettleState', items: [], allItems: [] },
    },
  };

  it('accepts a multi-member LIST literal condition instead of rejecting it as invalid syntax', async () => {
    const onChoiceConditionEdit = vi.fn().mockResolvedValue(undefined);
    render(<NodeDetail {...props({ onChoiceConditionEdit, variables: [kettleStateVariable] })} />);

    fireEvent.click(screen.getByText('+ Condition'));
    fireEvent.change(screen.getByLabelText('Choice 1 condition on her'), {
      target: { value: 'kettleState == (cold, boiling)' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onChoiceConditionEdit).toHaveBeenCalledWith(0, 'kettleState == (cold, boiling)');
    });
    expect(screen.queryByText(/is not a known LIST member|Invalid condition/)).toBeNull();
  });
});

describe('NodeDetail — assignment block preview', () => {
  it('renders a read-only preview of the statement', () => {
    render(
      <NodeDetail
        {...props({
          node: {
            content: [
              {
                kind: 'assignment',
                statement: {
                  kind: 'assignment',
                  name: 'gold',
                  operator: '+=',
                  value: { kind: 'literal', value: 5 },
                },
              },
            ],
            choices: [],
            divert: null,
            tags: [],
          },
        })}
      />,
    );
    expect(screen.getByText('~ gold += 5')).toBeTruthy();
  });

  it('shows the condition badge for a conditioned assignment block (SugarCube/Chapbook nested <<set>>, DEV-199 follow-up)', () => {
    render(
      <NodeDetail
        {...props({
          node: {
            content: [
              {
                kind: 'assignment',
                statement: {
                  kind: 'assignment',
                  name: 'transportation',
                  operator: '=',
                  value: { kind: 'literal', value: 'plane' },
                },
                condition: { kind: 'variable', name: 'far' },
              },
            ],
            choices: [],
            divert: null,
            tags: [],
          },
        })}
      />,
    );
    expect(screen.getByText('~ transportation = "plane"')).toBeTruthy();
    expect(screen.getByText('if far')).toBeTruthy();
  });
});
