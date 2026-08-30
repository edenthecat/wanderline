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
// The question is per KEY and per CONTROL, not per element. A <button>
// consumes Space and Enter and nothing else; a range input consumes the
// arrows and nothing else; a checkbox consumes only Space. Yielding
// every key to whatever has focus would break the shortcuts in the
// other direction — on a story whose author hid the visible choice
// list, the arrows are the only way to move the armed choice, and a
// listener who has just tapped the on-screen Play button still has
// focus sitting on it.

/**
 * Focusable things that act on keys. `closest()` rather than a tag test
 * so a press landing on an icon `<span>` inside a button still counts
 * as belonging to the button. A bare `[tabindex]` is deliberately NOT
 * here: a focusable div with no role has no default key behaviour to
 * protect, and matching one would hand it keys it never uses.
 */
const INTERACTIVE_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'a[href]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
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
 * typeahead, and therefore claim every key. `<select>` belongs here: it
 * takes arrows, Home/End and letter typeahead.
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

/** Adjusted with the arrow / Home / End / Page keys, activated by neither. */
const SLIDER_SELECTOR = 'input[type="range"], [role="slider"]';

/** Moved through with the arrows, selected with Space. */
const ARROW_SELECTED_SELECTOR = 'input[type="radio"], [role="radio"], [role="tab"]';

/** Toggled with Space and nothing else — Enter does not tick a checkbox. */
const SPACE_ONLY_SELECTOR = 'input[type="checkbox"], [role="checkbox"], [role="switch"]';

/** Followed with Enter; Space scrolls rather than activating a link. */
const ENTER_ONLY_SELECTOR = 'a[href], [role="link"], [role="menuitem"]';

const SPACE = new Set<string>([' ']);
const ENTER = new Set<string>(['Enter']);
/** Space + Enter: what a <button> turns into a click. */
const ACTIVATION_KEYS = new Set<string>([' ', 'Enter']);
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
const ARROWS_AND_SPACE = new Set<string>([...ADJUSTMENT_KEYS, ' ']);

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
 * The keys `el` acts on itself. `null` means "all of them" — a text
 * field takes letters, Backspace, arrows and Enter alike.
 *
 * Claimed per control type because the sets genuinely differ and the
 * leftovers matter: a range input does nothing with Space, so Space
 * over a focused volume slider must still reach the global pause
 * shortcut rather than scrolling the page.
 */
function keysClaimedBy(el: Element): Set<string> | null {
  if (el.matches(TEXT_ENTRY_SELECTOR)) return null;
  if (el.matches(SLIDER_SELECTOR)) return ADJUSTMENT_KEYS;
  if (el.matches(ARROW_SELECTED_SELECTOR)) return ARROWS_AND_SPACE;
  if (el.matches(SPACE_ONLY_SELECTOR)) return SPACE;
  if (el.matches(ENTER_ONLY_SELECTOR)) return ENTER;
  return ACTIVATION_KEYS;
}

/**
 * True when the keystroke landed on a focusable control at all,
 * whatever the key. Used for the choice-cycling keys, which have to
 * stand down near ANY control: they move the armed choice while Enter
 * activates whatever has focus, and the two must not be able to
 * disagree.
 */
export function isFromInteractiveElement(e: { target: EventTarget | null }): boolean {
  return closestMatch(e.target, INTERACTIVE_SELECTOR) !== null;
}

/**
 * True when this particular key belongs to the control the keystroke
 * landed on, so a global shortcut must stand down and let the browser's
 * default behaviour run.
 */
export function keyBelongsToTarget(e: { key: string; target: EventTarget | null }): boolean {
  const el = closestMatch(e.target, INTERACTIVE_SELECTOR);
  if (!el) return false;
  const claimed = keysClaimedBy(el);
  return claimed === null || claimed.has(e.key);
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
