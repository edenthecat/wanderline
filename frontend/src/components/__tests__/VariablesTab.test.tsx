import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import VariablesTab from '../VariablesTab';
import type { StoryGraph } from '../../api/client';

// DEV-199 Phase 5: authoring brand-new story variables. updateVariables
// is mocked; printExpression/printStatement are real (pure, no network)
// so the rendered "= <value>" text reflects the actual printer.
const mockUpdateVariables = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, updateVariables: mockUpdateVariables };
});

function graph(variables: StoryGraph['variables']): StoryGraph {
  return {
    id: 'g1',
    title: 'T',
    nodes: {},
    startNode: 'a',
    validation: { valid: true, errors: [], warnings: [] },
    variables,
  } as unknown as StoryGraph;
}

describe('VariablesTab', () => {
  it('shows the empty state when there are no variables', () => {
    render(<VariablesTab projectId="p1" storyGraph={graph([])} />);
    expect(screen.getByText('No variables yet.')).toBeTruthy();
  });

  it('lists existing variables with their inferred type and printed value', () => {
    render(
      <VariablesTab
        projectId="p1"
        storyGraph={graph([
          {
            name: 'gold',
            type: 'number',
            initialValue: { kind: 'literal', value: 10 },
            isConst: false,
          },
        ])}
      />,
    );
    expect(screen.getByText('gold')).toBeTruthy();
    expect(screen.getByText('number')).toBeTruthy();
    expect(screen.getByText('= 10')).toBeTruthy();
  });

  it('creates a new variable, sending the whole array including existing ones', async () => {
    mockUpdateVariables.mockResolvedValue({
      success: true,
      story_graph: graph([
        {
          name: 'gold',
          type: 'number',
          initialValue: { kind: 'literal', value: 10 },
          isConst: false,
        },
        {
          name: 'hasKey',
          type: 'bool',
          initialValue: { kind: 'literal', value: false },
          isConst: false,
        },
      ]),
    });
    const onStoryUpdated = vi.fn();
    render(
      <VariablesTab
        projectId="p1"
        storyGraph={graph([
          {
            name: 'gold',
            type: 'number',
            initialValue: { kind: 'literal', value: 10 },
            isConst: false,
          },
        ])}
        onStoryUpdated={onStoryUpdated}
      />,
    );

    fireEvent.click(screen.getByText('New variable'));
    fireEvent.change(screen.getByPlaceholderText('gold'), { target: { value: 'hasKey' } });
    fireEvent.change(screen.getByPlaceholderText('10, "Alex", or true'), {
      target: { value: 'false' },
    });
    fireEvent.click(screen.getByText('Create variable'));

    await waitFor(() => {
      expect(mockUpdateVariables).toHaveBeenCalledWith('p1', [
        { name: 'gold', initialValue: '10', isConst: false },
        { name: 'hasKey', initialValue: 'false', isConst: false },
      ]);
      expect(onStoryUpdated).toHaveBeenCalled();
    });
    expect(screen.getByText('hasKey')).toBeTruthy();
  });

  it('shows the server error message on a failed save', async () => {
    mockUpdateVariables.mockRejectedValue(new Error('Variable 1: duplicate name "gold"'));
    render(
      <VariablesTab
        projectId="p1"
        storyGraph={graph([
          {
            name: 'gold',
            type: 'number',
            initialValue: { kind: 'literal', value: 10 },
            isConst: false,
          },
        ])}
      />,
    );

    fireEvent.click(screen.getByText('New variable'));
    fireEvent.change(screen.getByPlaceholderText('gold'), { target: { value: 'gold' } });
    fireEvent.change(screen.getByPlaceholderText('10, "Alex", or true'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByText('Create variable'));

    await waitFor(() => {
      expect(screen.getByText('Variable 1: duplicate name "gold"')).toBeTruthy();
    });
  });

  it('deletes a variable after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockUpdateVariables.mockResolvedValue({ success: true, story_graph: graph([]) });
    render(
      <VariablesTab
        projectId="p1"
        storyGraph={graph([
          {
            name: 'gold',
            type: 'number',
            initialValue: { kind: 'literal', value: 10 },
            isConst: false,
          },
        ])}
      />,
    );

    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(mockUpdateVariables).toHaveBeenCalledWith('p1', []);
    });
    confirmSpy.mockRestore();
  });
});
