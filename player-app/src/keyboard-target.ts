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

/**
 * Elements that handle keystrokes themselves. `closest()` is used rather
 * than a tag check so a press landing on an icon `<span>` inside a
 * button still counts as belonging to the button.
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
  '[role="link"]',
  '[role="menuitem"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
].join(', ');

/** Elements that swallow ordinary character keys as typed text. */
const TEXT_ENTRY_SELECTOR = [
  'input',
  'select',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="textbox"]',
].join(', ');

/**
 * Duck-typed rather than `instanceof Element`: the event target may be
 * `window` or `document` (both lack `closest`), and jsdom's `Element`
 * is not always the same constructor the test realm sees.
 */
function matchesTarget(target: EventTarget | null, selector: string): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return (target as Element).closest(selector) !== null;
}

/**
 * True when the keystroke was aimed at a focusable control that acts on
 * keys itself. Global shortcuts must stand down for these.
 */
export function isFromInteractiveElement(e: { target: EventTarget | null }): boolean {
  return matchesTarget(e.target, INTERACTIVE_SELECTOR);
}

/**
 * Narrower check for handlers that only claim keys no control competes
 * for — the media-transport fallback claims `MediaPlayPause` and
 * friends, which no button consumes, so bailing on every focused button
 * there would kill headphone control the moment someone tapped Play.
 */
export function isFromTextEntry(e: { target: EventTarget | null }): boolean {
  return matchesTarget(e.target, TEXT_ENTRY_SELECTOR);
}
