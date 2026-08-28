// WCAG 2.x colour-contrast maths, shared by the editor's Theme tab,
// the backend's build-time smoke page and the player's own tests.
//
// This started life as private helpers inside
// player-app/src/theme-contrast.test.ts, where it could only ever
// assert things about the *shipped defaults*. Author-chosen colours —
// the ones that actually reach a listener — went unchecked, so an
// author could set body text and page background to the same value and
// nothing anywhere would say a word. Moving the maths into real source
// lets the Theme tab warn while the author is still editing and lets
// the generated smoke.html repeat the check on the built story.

export type Rgb = [number, number, number];

export interface Rgba {
  rgb: Rgb;
  /** 0–1. Opaque colours report 1. */
  alpha: number;
}

/** WCAG AA minimum for normal-size body text. */
export const AA_NORMAL_TEXT = 4.5;
/** WCAG AA minimum for large text (>=18.66px bold, or >=24px). */
export const AA_LARGE_TEXT = 3;
/** WCAG 1.4.11 minimum for UI-component and graphical boundaries. */
export const AA_NON_TEXT = 3;

// The handful of CSS keywords a colour knob realistically receives.
// Anything outside this list and the numeric syntaxes below is treated
// as "not a colour we can reason about" rather than guessed at.
const NAMED: Record<string, Rgb> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  navy: [0, 0, 128],
  teal: [0, 128, 128],
  transparent: [0, 0, 0],
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function parseChannel(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const pct = t.endsWith('%');
  const n = Number.parseFloat(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return null;
  return clamp(pct ? (n / 100) * 255 : n, 0, 255);
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const t = raw.trim();
  if (!t) return 1;
  const pct = t.endsWith('%');
  const n = Number.parseFloat(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return 1;
  return clamp(pct ? n / 100 : n, 0, 1);
}

/**
 * Parse a single CSS colour. Supports #rgb / #rgba / #rrggbb /
 * #rrggbbaa, rgb()/rgba() in both comma and space syntax, and a small
 * set of keywords. Returns null for anything else (gradients,
 * `var(...)`, colour functions we don't model) so callers can say
 * "can't check this" instead of inventing a number.
 */
export function parseColor(input: string): Rgba | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;

  if (value === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  if (Object.prototype.hasOwnProperty.call(NAMED, value)) {
    return { rgb: [...NAMED[value]] as Rgb, alpha: 1 };
  }

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const expand = (h: string) =>
      h
        .split('')
        .map((c) => c + c)
        .join('');
    let full: string;
    if (hex.length === 3 || hex.length === 4) full = expand(hex);
    else if (hex.length === 6 || hex.length === 8) full = hex;
    else return null;
    const rgb = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as Rgb;
    const alpha = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { rgb, alpha };
  }

  const fn = /^rgba?\(([^)]*)\)$/.exec(value);
  if (fn) {
    // `rgb(0 0 0 / 50%)` and `rgba(0, 0, 0, 0.5)` both land here.
    const [rgbPart, alphaPart] = fn[1].split('/');
    const parts = rgbPart
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const channels = parts.slice(0, 3).map(parseChannel);
    if (channels.some((c) => c === null)) return null;
    const alpha = parseAlpha(alphaPart ?? parts[3]);
    return { rgb: channels as Rgb, alpha };
  }

  return null;
}

/**
 * Pull every colour out of a CSS value. A plain colour yields one; a
 * gradient yields one per stop. Used so a background written as
 * `linear-gradient(#1a1a2e, #16213e)` is checked against *both* ends
 * rather than skipped — the text has to stay readable the whole way
 * down the page.
 */
export function extractColors(value: string): Rgba[] {
  if (typeof value !== 'string') return [];
  const single = parseColor(value);
  if (single) return [single];
  const tokens = value.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
  const out: Rgba[] = [];
  for (const token of tokens) {
    const parsed = parseColor(token);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** WCAG 2.x relative luminance for an sRGB triple. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = clamp(v, 0, 255) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two opaque colours. Always >= 1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite a colour at `alpha` over an opaque backdrop. */
export function composite(top: Rgb, bottom: Rgb, alpha: number): Rgb {
  const a = clamp(alpha, 0, 1);
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)) as Rgb;
}

/**
 * Flatten a stack of possibly-translucent layers onto an opaque base.
 * Layers are ordered bottom-to-top, which is how a card tint over a
 * card background over a page background actually stacks.
 */
export function flatten(layers: Rgba[], base: Rgb): Rgb {
  return layers.reduce<Rgb>((acc, layer) => composite(layer.rgb, acc, layer.alpha), base);
}
