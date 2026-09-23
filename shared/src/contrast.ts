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

// Anchored CSS-number grammar, shared with parseAlpha and
// parseHslComponent below. Number.parseFloat alone reads a leading
// run of digits and silently drops the rest of the string —
// `rgb(255,0,0junk)` parsed as channel 0 instead of being rejected,
// so the checker measured a colour the browser never painted (the
// whole declaration is invalid and discarded) and could hand back a
// confident, wrong verdict for it.
const CSS_NUMBER_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
// Same token, with an optional angle unit — built once at module load
// rather than per call, since parseHue runs once per gradient stop on
// an author-controlled string.
const CSS_HUE_TOKEN = new RegExp(
  `^(${CSS_NUMBER_TOKEN.source.slice(1, -1)})(deg|rad|grad|turn)?$`,
  'i',
);

function parseChannel(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const pct = t.endsWith('%');
  const body = pct ? t.slice(0, -1) : t;
  if (!CSS_NUMBER_TOKEN.test(body)) return null;
  const n = Number.parseFloat(body);
  if (!Number.isFinite(n)) return null;
  return clamp(pct ? (n / 100) * 255 : n, 0, 255);
}

// The three regexes below all match a CSS <number>, and all spell
// it the same deliberate way.
//
// `\d+\.?\d*` looks equivalent and is not: with the `.` optional and a
// second `\d*` behind it, a run of digits can be divided between the
// two quantifiers in as many ways as it is long. Anchored, a run that
// fails at the end backtracks through every one of them — quadratic,
// on strings these functions take straight from an author's theme
// (CodeQL js/polynomial-redos). 8k digits took 52ms; this shape takes
// 0.03ms and accepts exactly the same numbers. Requiring the `.`
// before the fractional digits leaves a digit run only one way to
// match.
/**
 * Alpha, or null when one was written and cannot be read.
 *
 * Defaulting a bad token to 1 made `rgba(0, 0, 0, banana)` parse as
 * opaque black — a value the browser throws out entirely, so the
 * checker was measuring a colour no listener would ever see, and
 * measuring it as the most contrasting thing available. `undefined`
 * still means "no alpha written", which is a real 1.
 */
function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const t = raw.trim();
  if (!t) return null;
  const pct = t.endsWith('%');
  const body = pct ? t.slice(0, -1) : t;
  if (!CSS_NUMBER_TOKEN.test(body.trim())) return null;
  const n = Number.parseFloat(body);
  if (!Number.isFinite(n)) return null;
  return clamp(pct ? n / 100 : n, 0, 1);
}

/**
 * A hue in degrees. CSS allows `deg`, `rad`, `grad` and `turn`, and a
 * bare number means degrees.
 *
 * Number.parseFloat alone read the digits and dropped the unit, so
 * `hsl(0.5turn 100% 50%)` — half a turn, which is cyan — came out as
 * hue 0.5, which is red. Silently, and with a confident contrast ratio
 * attached to it.
 */
function parseHue(raw: string): number | null {
  const m = CSS_HUE_TOKEN.exec(raw.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? 'deg').toLowerCase()) {
    case 'rad':
      return (n * 180) / Math.PI;
    case 'grad':
      return n * 0.9;
    case 'turn':
      return n * 360;
    default:
      return n;
  }
}

/**
 * An hsl() saturation or lightness: a percentage, or a bare number
 * meaning the same. Anything carrying another unit is not a valid
 * component and is rejected rather than having its digits taken.
 */
function parseHslComponent(raw: string): number | null {
  const t = raw.trim();
  const body = t.endsWith('%') ? t.slice(0, -1) : t;
  if (!CSS_NUMBER_TOKEN.test(body)) return null;
  const n = Number.parseFloat(body);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a single CSS colour. Supports #rgb / #rgba / #rrggbb /
 * #rrggbbaa, rgb()/rgba() and hsl()/hsla() in both comma and space
 * syntax, and a small set of keywords. Returns null for anything else
 * (gradients, `var(...)`, colour functions we don't model) so callers
 * can say "can't check this" instead of inventing a number — see
 * `unevaluatedThemeContrast`, which makes that state visible rather
 * than letting it read as a pass.
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

  const rgbFn = /^rgba?\(([^)]*)\)$/.exec(value);
  if (rgbFn) {
    // `rgb(0 0 0 / 50%)` and `rgba(0, 0, 0, 0.5)` both land here.
    const parts = splitColorArgs(rgbFn[1]);
    if (!parts) return null;
    const channels = parts.values.map(parseChannel);
    if (channels.some((c) => c === null)) return null;
    return { rgb: channels as Rgb, alpha: parts.alpha };
  }

  const hslFn = /^hsla?\(([^)]*)\)$/.exec(value);
  if (hslFn) {
    const parts = splitColorArgs(hslFn[1]);
    if (!parts) return null;
    const h = parseHue(parts.values[0]);
    const sat = parseHslComponent(parts.values[1]);
    const light = parseHslComponent(parts.values[2]);
    if (h === null || sat === null || light === null) return null;
    return { rgb: hslToRgb(h, sat / 100, light / 100), alpha: parts.alpha };
  }

  return null;
}

/**
 * Split the argument list of an rgb()/hsl() function into its three
 * components plus an alpha, accepting both the comma syntax and the
 * space + `/` syntax.
 */
function splitColorArgs(args: string): { values: [string, string, string]; alpha: number } | null {
  // CSS allows at most one `/` in this syntax (`rgb(0 0 0 / 50%)`).
  // `args.split('/')` doesn't enforce that: destructuring only the
  // first two elements of the result silently drops everything after
  // a second slash, so `rgb(0 0 0 / 0.5 / 0)` — which the browser
  // rejects outright — read as alpha 0.5 here instead of failing.
  const segments = args.split('/');
  if (segments.length > 2) return null;
  const [head, alphaPart] = segments;
  const parts = head
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  // Comma syntax puts alpha as a 4th comma-separated value
  // (`rgba(0,0,0,0.5)`); slash syntax puts it after `/`. The two are
  // mutually exclusive in real CSS — mixing them (`rgb(0,0,0/0.5)`)
  // is invalid — but this function is a lenient value-extractor, not
  // a full grammar, so it only refuses to silently pick one arbitrarily
  // when both are absent and there's nothing to guess from.
  const alpha = parseAlpha(alphaPart ?? parts[3]);
  if (alpha === null) return null;
  return { values: parts.slice(0, 3) as [string, string, string], alpha };
}

/** CSS Color 3 hsl() → sRGB. Hue in degrees, s/l as 0–1 fractions. */
function hslToRgb(hue: number, s: number, l: number): Rgb {
  const sat = clamp(s, 0, 1);
  const light = clamp(l, 0, 1);
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Everything in a CSS value that is *shaped* like a colour — matching
 * this does not mean `parseColor` will accept it (`#abcde` matches and
 * is not a colour). Callers that need to know whether they read the
 * whole value compare what this finds against what parsed.
 *
 * Returns a fresh regex each call: it carries the `g` flag, and a
 * shared instance would drag `lastIndex` between callers.
 *
 * `[^()]` rather than `[^)]`: this scans an author-controlled string
 * from every start position, and with `[^)]*` an input like
 * `rgb(rgb(rgb(…` with no closing paren makes each `rgb(` consume the
 * rest of the string before failing — quadratic, and reachable from a
 * stored theme value (CodeQL js/polynomial-redos). Stopping at the
 * next paren bounds the work per start position and costs nothing:
 * CSS colour functions don't nest parens, and anything that does
 * (`rgb(calc(…))`) wasn't parseable here anyway.
 */
export function colorTokenPattern(): RegExp {
  return /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)|hsla?\([^()]*\)/g;
}

/**
 * Pull every colour out of a CSS value. A plain colour yields one; a
 * gradient yields one per stop. Used so a background written as
 * `linear-gradient(#1a1a2e, #16213e)` is checked against *both* ends
 * rather than skipped — the text has to stay readable the whole way
 * down the page.
 *
 * Tokens it can't parse are dropped. That is fine for "show me the
 * colours in here" and wrong for "is this readable", so anything
 * forming a verdict must check for completeness itself.
 */
export function extractColors(value: string): Rgba[] {
  if (typeof value !== 'string') return [];
  const single = parseColor(value);
  if (single) return [single];
  const tokens = value.match(colorTokenPattern()) ?? [];
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
