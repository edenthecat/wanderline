import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  CATEGORY_LABEL,
  buildCatalogFontsUrl,
  filterFonts,
  type GoogleFontEntry,
} from '../api/google-fonts';

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  testId?: string;
}

// follow-up: searchable Google Fonts combobox. Replaces the
// plain `<input + datalist>` font field. Filters by name + category,
// keyboard-navigable, and renders each row in its own typeface by
// lazily injecting one Google Fonts <link> covering every family in
// the catalog the first time the dropdown opens.
//
// The user can still type a family name we don't list — the value
// is whatever's in the text field, not what they "selected". That
// keeps the door open for less-popular Google Fonts and avoids
// blocking on an exhaustive catalog.

let stylesheetInjected = false;
function ensureCatalogStylesheet() {
  if (stylesheetInjected) return;
  if (typeof document === 'undefined') return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = buildCatalogFontsUrl();
  link.dataset.wanderlineFontCatalog = '1';
  document.head.appendChild(link);
  stylesheetInjected = true;
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  padding: '6px 10px',
  cursor: 'pointer',
  gap: 12,
};

const dropdownStyle: CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  right: 0,
  maxHeight: 280,
  overflowY: 'auto',
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, rgba(0,0,0,0.15))',
  borderRadius: 6,
  marginTop: 4,
  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
  zIndex: 10,
  padding: 4,
};

export default function FontPicker({ value, onChange, placeholder, ariaLabel, testId }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const filtered = useMemo(() => filterFonts(filter), [filter]);

  // Inject the catalog stylesheet the first time the dropdown opens —
  // skip it on mount so unthemed projects don't pay the network cost.
  useEffect(() => {
    if (!open) return;
    ensureCatalogStylesheet();
    setHighlight(0);
  }, [open]);

  // Outside-click + escape close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (inputRef.current?.contains(t) || dropdownRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(entry: GoogleFontEntry) {
    onChange(entry.family);
    setFilter('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      const entry = filtered[highlight];
      if (entry) {
        e.preventDefault();
        pick(entry);
      }
    } else if (e.key === 'Tab') {
      // Tab closes without confirming — the value in the text field
      // is whatever the user has typed.
      setOpen(false);
    }
  }

  return (
    <div style={{ position: 'relative', width: 220 }} data-testid={testId}>
      <input
        ref={inputRef}
        type="text"
        value={open ? filter : value}
        onChange={(e) => {
          setFilter(e.target.value);
          // Reflect typed text directly so users can hand-enter a
          // family that isn't in the catalog.
          onChange(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        autoComplete="off"
        spellCheck={false}
        style={{ width: '100%', fontFamily: value ? `'${value}', sans-serif` : undefined }}
      />
      {open && (
        <div
          ref={dropdownRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel ? `${ariaLabel} options` : 'Font options'}
          style={dropdownStyle}
          data-testid={testId ? `${testId}-dropdown` : undefined}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 12px', color: 'var(--color-muted, #888)' }}>
              No matches — keep typing to use a family that&apos;s not in our catalog.
            </div>
          ) : (
            filtered.map((entry, i) => {
              const selected = entry.family === value;
              const highlighted = i === highlight;
              return (
                <div
                  key={entry.family}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(entry);
                  }}
                  style={{
                    ...rowStyle,
                    background: highlighted
                      ? 'rgba(78,205,196,0.12)'
                      : selected
                        ? 'rgba(78,205,196,0.06)'
                        : 'transparent',
                    fontFamily: `'${entry.family}', sans-serif`,
                  }}
                >
                  <span>{entry.family}</span>
                  <span
                    className="text-sm text-muted"
                    style={{ fontFamily: 'system-ui, sans-serif', fontSize: 11 }}
                  >
                    {CATEGORY_LABEL[entry.category]}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
