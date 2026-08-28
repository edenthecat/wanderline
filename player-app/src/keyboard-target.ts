// Helpers for deciding whether a window-level keydown belongs to the
// player's global shortcuts or to the control the listener is actually
// focused on.
//
// The player binds its shortcuts to `window` so a listener with the
// phone in a pocket can drive the story without touching anything. The
// cost is that those handlers also see keystrokes aimed at real
// controls. `Enter` on the Settings cog, `Space` on the "Advance
// automatically" checkbox and `ArrowUp`/`ArrowDown` on a volume slider
// are all keystrokes the browser turns into activation or adjustment —
// and `preventDefault()` in a window handler cancels that before it
// happens, which left every button and input in the player unusable by
// keyboard.
//
// The question is per KEY, not per element. A `<button>` consumes Space
// and Enter and nothing else, so yielding every key to it would break
// the shortcuts in the other direction: on a story whose author hid the
// visible choice list, the arrows are the only way to move the armed
// choice, and a listener who has just tapped the on-screen Play button
// still has focus sitting on it.

/**
 * Focusable things that act on keys. `closest()` rather than a tag test
 * so a press landing on an icon `<span>` inside a button still counts
 * as belonging to the button.
 */
const INTERACTIVE_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
].join(', ');

/**
 * Controls that swallow ordinary character keys as typed text or
 * typeahead, and therefore claim everything. `<select>` belongs here:
 * it takes arrows, Home/End and letter typeahead.
 */
const TEXT_ENTRY_SELECTOR = [
  'input:not([type="range"]):not([type="checkbox"]):not([type="radio"])' +
    ':not([type="button"]):not([type="submit"]):not([type="reset"])',
  'select',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
].join(', ');

/** Controls adjusted with the arrow / Home / End / Page keys. */
const ADJUSTABLE_SELECTOR = [
  'input[type="range"]',
  'input[type="radio"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="tab"]',
].join(', ');

/** Keys the browser turns into "activate this control". */
const ACTIVATION_KEYS = new Set<string>([' ', 'Enter']);

/** Keys an adjustable control consumes, on top of the activation pair. */
const ADJUSTMENT_KEYS = new Set<string>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * Duck-typed rather than `instanceof Element`: the event target may be
 * `window` or `document` (both lack `closest`), and jsdom's `Element`
 * is not always the same constructor the test realm sees.
 */
function closestMatch(target: EventTarget | null, selector: string): Element | null {
  if (!target || typeof (target as Element).closest !== 'function') return null;
  return (target as Element).closest(selector);
}

/**
 * True when this particular key belongs to the control the keystroke
 * landed on, so a global shortcut must stand down and let the browser's
 * default behaviour run.
 */
export function keyBelongsToTarget(e: { key: string; target: EventTarget | null }): boolean {
  const el = closestMatch(e.target, INTERACTIVE_SELECTOR);
  if (!el) return false;
  // A field takes every key: letters are text, Backspace deletes,
  // arrows move the caret, Enter submits.
  if (el.matches(TEXT_ENTRY_SELECTOR)) return true;
  if (el.matches(ADJUSTABLE_SELECTOR)) {
    return ACTIVATION_KEYS.has(e.key) || ADJUSTMENT_KEYS.has(e.key);
  }
  // Buttons, links, checkboxes, switches, menu items: activation only.
  return ACTIVATION_KEYS.has(e.key);
}

/**
 * True when the keystroke landed in a field that treats keys as typed
 * text. Used by the media-transport fallback, which claims only the
 * `Media*` keys: no control competes for those, so anything broader
 * there would silently kill headphone control the moment focus landed
 * on a button or a volume slider.
 */
export function isFromTextEntry(e: { target: EventTarget | null }): boolean {
  return closestMatch(e.target, TEXT_ENTRY_SELECTOR) !== null;
}
