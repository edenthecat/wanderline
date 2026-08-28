// ⌘K / Ctrl-K command palette for the project editor.
//
// The only thing this file knows how to do is draw a modal listbox
// over the workspace and run whichever command the author picks.
// What those commands ARE lives in lib/commandPalette — today that's
// "jump to a passage"; tomorrow it's flags, unreachable nodes, or
// "preview from here", added as a provider without touching this
// component.
//
// Keyboard/AT contract (mirrors the combobox+listbox pattern already
// used by FontPicker, with the bits a modal additionally owes):
//   - focus moves into the input on open and back to the invoker on close
//   - Tab is trapped inside the dialog
//   - the input is a combobox pointing at the listbox via
//     aria-controls + aria-activedescendant; the highlighted row is
//     the only aria-selected one
//   - the match count is announced through a polite live region
//   - Escape closes, ↑/↓/Home/End move, Enter runs

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { StoryGraph } from '../api/client';
import {
  buildCommands,
  DEFAULT_PROVIDERS,
  type CommandProvider,
  type PaletteActions,
  type PaletteCommand,
} from '../lib/commandPalette';

interface Props {
  open: boolean;
  onClose: () => void;
  storyGraph: StoryGraph | null;
  /** Verbs the host page can perform. Memoize it — it's a build dep. */
  actions: PaletteActions;
  /** Override point for tests and for future per-page command sets. */
  providers?: readonly CommandProvider[];
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function CommandPalette({
  open,
  onClose,
  storyGraph,
  actions,
  providers = DEFAULT_PROVIDERS,
}: Props) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const { commands, totalCount, truncated } = useMemo(
    () => buildCommands({ query, storyGraph, actions }, providers),
    [query, storyGraph, actions, providers],
  );

  // Clamp rather than trust: the list shrinks as the author types and
  // a stale index would point past the end for one render.
  const activeIndex = commands.length === 0 ? -1 : Math.min(highlight, commands.length - 1);
  const activeCommand: PaletteCommand | undefined =
    activeIndex >= 0 ? commands[activeIndex] : undefined;

  // Fresh query every time it opens — a palette that remembers last
  // week's search is a palette you have to clear before using.
  // Focus goes in on open and back to the invoker on close.
  useEffect(() => {
    if (!open) return;
    const invoker = document.activeElement as HTMLElement | null;
    setQuery('');
    setHighlight(0);
    inputRef.current?.focus();
    return () => {
      // Guard: the invoker may have been unmounted while we were open
      // (a tab switch), and jsdom-only elements may lack focus().
      if (invoker && typeof invoker.focus === 'function' && document.contains(invoker)) {
        invoker.focus();
      }
    };
  }, [open]);

  const runCommand = useCallback(
    (command: PaletteCommand) => {
      // Close first so focus restoration lands before the command's
      // own focus moves (a jump scrolls the list, not the caret).
      onClose();
      command.run();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        // Focus trap. The dialog is small enough that querying on each
        // Tab is cheaper than maintaining a list.
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
        );
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const current = document.activeElement;
        if (e.shiftKey && (current === first || !dialogRef.current?.contains(current))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (current === last || !dialogRef.current?.contains(current))) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (commands.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1 >= commands.length ? 0 : h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h <= 0 ? commands.length - 1 : h - 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setHighlight(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setHighlight(commands.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeCommand) runCommand(activeCommand);
      }
    },
    [activeCommand, commands.length, onClose, runCommand],
  );

  // Keep the highlighted row visible as the arrow keys walk past the
  // fold. `block: 'nearest'` scrolls the list, never the page.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(activeIndex))}`);
    // jsdom doesn't implement scrollIntoView.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    // optionId is derived from baseId, which is stable for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex, baseId]);

  if (!open) return null;

  // Group headings: commands arrive grouped and contiguous from
  // buildCommands, so a heading is emitted whenever the group changes.
  let previousGroup: string | null = null;

  return (
    <div
      className="command-palette-backdrop"
      data-testid="command-palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Re-ranking moves the best match to the top; keeping an
            // old index would leave the highlight on an unrelated row.
            setHighlight(0);
          }}
          placeholder="Jump to a passage…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeCommand ? optionId(activeIndex) : undefined}
          autoComplete="off"
          spellCheck={false}
        />

        <p
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="command-palette-status"
        >
          {totalCount === 0
            ? 'No results'
            : `${totalCount} result${totalCount === 1 ? '' : 's'}${
                truncated ? `, showing the first ${commands.length}` : ''
              }`}
        </p>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="command-palette-list"
          data-testid="command-palette-list"
        >
          {commands.map((command, index) => {
            const heading = command.group !== previousGroup ? command.group : null;
            previousGroup = command.group;
            const isActive = index === activeIndex;
            return (
              // Fragment, not a wrapper element: a listbox's options
              // have to be its own children for AT to count them.
              <Fragment key={command.id}>
                {heading && (
                  <div className="command-palette-group" role="presentation">
                    {heading}
                  </div>
                )}
                <div
                  id={optionId(index)}
                  role="option"
                  aria-selected={isActive}
                  className={`command-palette-option${isActive ? ' is-active' : ''}`}
                  onMouseMove={() => setHighlight(index)}
                  onMouseDown={(e) => {
                    // Keep focus in the input so the close handler
                    // restores to the real invoker, not this row.
                    e.preventDefault();
                    runCommand(command);
                  }}
                >
                  <span className="command-palette-option-label">{command.label}</span>
                  {command.hint && (
                    <span className="command-palette-option-hint">{command.hint}</span>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>

        {commands.length === 0 && <p className="command-palette-empty">No matches.</p>}
        {truncated && (
          <p className="command-palette-truncated">
            Showing {commands.length} of {totalCount} — keep typing to narrow.
          </p>
        )}
      </div>
    </div>
  );
}
