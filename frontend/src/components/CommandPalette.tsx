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
//   - Escape closes, ↑/↓ move, Enter runs. Home/End are deliberately
//     NOT bound: this combobox has an editable textbox, and the
//     author needs them to move the caret in what they typed.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import type { StoryGraph } from '../api/client';
import {
  buildCommands,
  DEFAULT_PROVIDERS,
  type CommandBuildResult,
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
  /** Where focus goes when the element that opened the palette is no
   * longer on screen — a command that switches tabs unmounts its own
   * invoker. Point this at a `tabIndex={-1}` region that survives.
   * Without it focus falls to <body> and the author loses their
   * place in the tab order. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

const EMPTY_RESULT: CommandBuildResult = { commands: [], totalCount: 0, truncated: false };

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function CommandPalette({
  open,
  onClose,
  storyGraph,
  actions,
  providers = DEFAULT_PROVIDERS,
  fallbackFocusRef,
}: Props) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  // Announced result count. Deliberately empty on the render that
  // mounts the palette — see the effect that fills it.
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  // Fresh query every time it opens — a palette that remembers last
  // week's search is a palette you have to clear before using. This
  // is done during render rather than in an effect on purpose: the
  // component stays mounted while closed, so an effect would let one
  // frame paint with the previous query and its results, and let the
  // live region announce that stale count before clearing it.
  const wasOpenRef = useRef(open);
  if (open !== wasOpenRef.current) {
    wasOpenRef.current = open;
    if (open) {
      setQuery('');
      setHighlight(0);
      setStatus('');
    }
  }

  // Nothing to build while it's shut — this memo would otherwise
  // re-run on every storyGraph refetch behind a closed palette.
  const { commands, totalCount, truncated } = useMemo(
    () => (open ? buildCommands({ query, storyGraph, actions }, providers) : EMPTY_RESULT),
    [open, query, storyGraph, actions, providers],
  );

  // Commands arrive grouped and contiguous from buildCommands, so a
  // single pass turns the flat list into render groups while keeping
  // each command's flat index — that index is what the highlight and
  // aria-activedescendant count through.
  const groups = useMemo(() => {
    const out: { name: string; items: { command: PaletteCommand; index: number }[] }[] = [];
    commands.forEach((command, index) => {
      const last = out[out.length - 1];
      if (last && last.name === command.group) last.items.push({ command, index });
      else out.push({ name: command.group, items: [{ command, index }] });
    });
    return out;
  }, [commands]);

  // Clamp rather than trust: the list shrinks as the author types and
  // a stale index would point past the end for one render.
  const activeIndex = commands.length === 0 ? -1 : Math.min(highlight, commands.length - 1);
  const activeCommand: PaletteCommand | undefined =
    activeIndex >= 0 ? commands[activeIndex] : undefined;

  // The fallback is read at close time, not bound at open time.
  const fallbackRef = useRef(fallbackFocusRef);
  useEffect(() => {
    fallbackRef.current = fallbackFocusRef;
  }, [fallbackFocusRef]);

  // Focus goes in on open and back to the invoker on close.
  useEffect(() => {
    if (!open) return;
    const invoker = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      // Running a command and closing are one commit, so by now the
      // invoker may already be gone — a jump that switches tabs
      // unmounts the button that opened us. Fall back rather than
      // dropping focus on <body>. (jsdom elements may lack focus().)
      // <body> is what document.activeElement reports when nothing is
      // focused — the author opened us straight off a page load. It is
      // "in the document" and has a focus() method, so a naive
      // liveness check would call it, achieve nothing, and skip the
      // fallback in exactly the case the fallback exists for.
      const usable =
        invoker &&
        invoker !== document.body &&
        invoker !== document.documentElement &&
        document.contains(invoker);
      const fallback = fallbackRef.current?.current ?? null;
      const target = usable ? invoker : fallback;
      if (target && typeof target.focus === 'function') target.focus();
      // ...and then check again once the dust settles. The command we
      // just ran can unmount the invoker a commit LATER than this
      // cleanup — a jump out of StoryTab's Source view unmounts
      // CodeMirror from a create-phase effect — and the liveness check
      // above structurally cannot see that. The browser drops focus to
      // <body> when the focused element leaves the DOM, so re-check on
      // a macrotask and catch it there.
      if (!fallback || target === fallback) return;
      // A cleanup can't itself return a cleanup, so this timer isn't
      // cancellable — both guards below make a late run harmless: it
      // no-ops if anything holds focus (including a palette the author
      // has already reopened) or if the fallback is gone.
      setTimeout(() => {
        const active = document.activeElement;
        const stranded = !active || active === document.body || active === document.documentElement;
        if (stranded && document.contains(fallback)) fallback.focus();
      }, 0);
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
      // Mid-IME-composition, Enter and Escape belong to the input
      // method (commit / cancel the candidate), not to us. Without
      // this, confirming a Japanese or Chinese passage name would run
      // whatever command happened to be highlighted.
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // React attaches at the root container, so without this the
        // native event still reaches the document-level Escape
        // handlers behind the modal: the export dropdown would close
        // too (yanking focus to its button, ahead of our own
        // restoration) and so would the mobile group sheet, neither of
        // which the author asked to dismiss.
        e.stopPropagation();
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
      // Step from activeIndex, not from the raw highlight state: the
      // list can shrink under us (a collaborator's save refetches the
      // graph) without the query changing, and stepping from a
      // now-out-of-range state would leave ArrowUp looking frozen.
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight(activeIndex + 1 >= commands.length ? 0 : activeIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight(activeIndex <= 0 ? commands.length - 1 : activeIndex - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeCommand) runCommand(activeCommand);
      }
    },
    [activeCommand, activeIndex, commands.length, onClose, runCommand],
  );

  // A live region is silent for content that is already there when
  // the region is inserted, and this whole subtree mounts on open. So
  // the count goes in one commit later, where it reads as a change.
  useEffect(() => {
    if (!open) return;
    setStatus(
      totalCount === 0
        ? 'No results'
        : `${totalCount} result${totalCount === 1 ? '' : 's'}${
            truncated ? `, showing the first ${commands.length}` : ''
          }`,
    );
  }, [open, totalCount, truncated, commands.length]);

  // Keep the highlighted row visible as the arrow keys walk past the
  // fold. `block: 'nearest'` scrolls the list, never the page.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(activeIndex))}`);
    // jsdom doesn't implement scrollIntoView.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    // `commands` is a dep even though it isn't read: a keystroke can
    // rebuild the list without moving activeIndex (it resets to 0,
    // which it often already was), leaving a hand-scrolled listbox
    // showing mid-list rows and no visible selection.
    // optionId is derived from baseId, which is stable for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex, commands, baseId]);

  if (!open) return null;

  return (
    <div
      className="command-palette-backdrop"
      data-testid="command-palette-backdrop"
      onMouseDown={(e) => {
        // Primary button only — a right-click on the dimmed backdrop
        // is reaching for a context menu, not dismissing the palette.
        if (e.button === 0 && e.target === e.currentTarget) onClose();
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
        onMouseDown={(e) => {
          // Clicking the palette's own chrome — padding, a group
          // heading, a result row — would blur the input to <body>,
          // which silently kills the arrow keys and lets the next Tab
          // walk into the page behind the modal. Keep focus in the
          // input for every mousedown that isn't aimed at it.
          if (e.target !== inputRef.current) e.preventDefault();
        }}
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
          {status}
        </p>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="command-palette-list"
          data-testid="command-palette-list"
        >
          {groups.map((group) => (
            // A real ARIA group, not a bare heading row: a listbox's
            // children must be options or groups, or AT can miscount
            // "option N of M".
            <div key={group.name} role="group" aria-label={group.name}>
              <div className="command-palette-group" aria-hidden="true">
                {group.name}
              </div>
              {group.items.map(({ command, index }) => {
                const isActive = index === activeIndex;
                return (
                  <div
                    key={command.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    className={`command-palette-option${isActive ? ' is-active' : ''}`}
                    onMouseMove={() => setHighlight(index)}
                    // Activate on click, not mousedown: a screen
                    // reader in browse mode dispatches a click with no
                    // mousedown before it, and a row that advertises
                    // role="option" has to answer that. Focus is kept
                    // in the input by the dialog's own mousedown.
                    onClick={(e) => {
                      if (e.button === 0) runCommand(command);
                    }}
                  >
                    <span className="command-palette-option-label">{command.label}</span>
                    {command.hint && (
                      <span className="command-palette-option-hint">{command.hint}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
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
