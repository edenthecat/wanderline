import { describe, it, expect, afterEach } from 'vitest';
import { keyBelongsToTarget, isFromTextEntry } from './keyboard-target';

// The player's shortcuts live on `window`, so they see every keystroke
// in the page — including ones aimed at a control. Which keys a control
// actually acts on differs by control, and the leftovers are what the
// global shortcuts keep. Getting either half wrong is silent: too
// greedy and buttons stop working by keyboard, too generous and Space
// stops pausing.

function mount(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild!;
}

afterEach(() => {
  document.body.innerHTML = '';
});

function claims(el: Element, key: string): boolean {
  return keyBelongsToTarget({ key, target: el });
}

describe('keyBelongsToTarget', () => {
  it('gives a button Space and Enter, and nothing else', () => {
    const el = mount('<button>Go</button>');
    expect(claims(el, ' ')).toBe(true);
    expect(claims(el, 'Enter')).toBe(true);
    for (const key of ['ArrowUp', 'ArrowDown', 'Backspace', 'Escape', 'r', 's']) {
      expect(claims(el, key), key).toBe(false);
    }
  });

  it('counts a press landing on an icon inside a button as the button', () => {
    const button = mount('<button><span data-icon="1">x</span></button>');
    const icon = button.querySelector('[data-icon]')!;
    expect(claims(icon, 'Enter')).toBe(true);
    expect(claims(icon, 'ArrowDown')).toBe(false);
  });

  it('gives a range input the adjustment keys but neither Space nor Enter', () => {
    // A slider has no default action for Space, so Space over a focused
    // volume slider must still reach the global pause shortcut.
    const el = mount('<input type="range" />');
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(claims(el, key), key).toBe(true);
    }
    expect(claims(el, ' ')).toBe(false);
    expect(claims(el, 'Enter')).toBe(false);
  });

  it('gives a checkbox Space only', () => {
    // Enter does not tick a checkbox outside a form.
    const el = mount('<input type="checkbox" />');
    expect(claims(el, ' ')).toBe(true);
    expect(claims(el, 'Enter')).toBe(false);
    expect(claims(el, 'ArrowDown')).toBe(false);
  });

  it('gives a radio the arrows and Space', () => {
    const el = mount('<input type="radio" />');
    expect(claims(el, ' ')).toBe(true);
    expect(claims(el, 'ArrowDown')).toBe(true);
    expect(claims(el, 'Enter')).toBe(false);
  });

  it('gives a link Enter only — Space scrolls rather than following it', () => {
    const el = mount('<a href="#main">Skip</a>');
    expect(claims(el, 'Enter')).toBe(true);
    expect(claims(el, ' ')).toBe(false);
  });

  it('gives a text field every key', () => {
    const el = mount('<input type="password" />');
    for (const key of [' ', 'Enter', 'Backspace', 'ArrowLeft', 'r', 's', 'Escape']) {
      expect(claims(el, key), key).toBe(true);
    }
  });

  it('gives a select every key, for arrow navigation and typeahead', () => {
    const el = mount('<select><option>a</option></select>');
    expect(claims(el, 'ArrowDown')).toBe(true);
    expect(claims(el, 'a')).toBe(true);
  });

  it('claims nothing for a plain element or a bare tabindex', () => {
    // A focusable div with no role has no default key behaviour to
    // protect; matching it would hand it keys it never uses.
    expect(claims(mount('<p>text</p>'), 'Enter')).toBe(false);
    expect(claims(mount('<div tabindex="0">text</div>'), 'Enter')).toBe(false);
  });

  it('claims nothing when the event came from window or document', () => {
    expect(keyBelongsToTarget({ key: 'Enter', target: window })).toBe(false);
    expect(keyBelongsToTarget({ key: 'Enter', target: document })).toBe(false);
    expect(keyBelongsToTarget({ key: 'Enter', target: null })).toBe(false);
  });

  it('honours ARIA roles on non-native elements', () => {
    expect(claims(mount('<div role="slider">v</div>'), 'ArrowUp')).toBe(true);
    expect(claims(mount('<div role="slider">v</div>'), ' ')).toBe(false);
    expect(claims(mount('<div role="button">go</div>'), ' ')).toBe(true);
    expect(claims(mount('<div role="switch">on</div>'), 'Enter')).toBe(false);
    expect(claims(mount('<div role="textbox">t</div>'), 'Backspace')).toBe(true);
  });
});

describe('isFromTextEntry', () => {
  it('is true only for controls that treat keys as typed text', () => {
    expect(isFromTextEntry({ target: mount('<input type="password" />') })).toBe(true);
    expect(isFromTextEntry({ target: mount('<textarea></textarea>') })).toBe(true);
    expect(isFromTextEntry({ target: mount('<div contenteditable="true">x</div>') })).toBe(true);
  });

  it('is false for the controls the media-key fallback must keep working over', () => {
    // Anything broader here kills headphone control the moment focus
    // lands on a button or a volume slider.
    expect(isFromTextEntry({ target: mount('<input type="range" />') })).toBe(false);
    expect(isFromTextEntry({ target: mount('<input type="checkbox" />') })).toBe(false);
    expect(isFromTextEntry({ target: mount('<button>Play</button>') })).toBe(false);
    expect(isFromTextEntry({ target: window })).toBe(false);
  });
});
