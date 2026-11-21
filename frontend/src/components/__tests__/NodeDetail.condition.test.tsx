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
});
