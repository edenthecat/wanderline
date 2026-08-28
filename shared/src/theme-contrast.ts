import {
  AA_LARGE_TEXT,
  AA_NORMAL_TEXT,
  composite,
  contrastRatio,
  flatten,
  colorTokenPattern,
  parseColor,
  type Rgb,
  type Rgba,
} from './contrast.js';

// One implementation of "is this author's palette readable", shared by
// the editor's Theme tab (warns while they're still picking) and the
// build's smoke.html (warns on the page authors are told to open
// before publishing). Two copies would drift, and the copy that
// drifted would be the one telling someone their story is fine.

export interface ThemePalette {
  pageBackground?: string;
  cardBackground?: string;
  textColor?: string;
  headingColor?: string;
  chromeColor?: string;
  accentColor?: string;
}

/** The `{ variables, components }` shape the Theme tab edits and stores. */
export interface ThemeInput {
  variables?: ThemePalette;
  components?: Record<string, Record<string, string | undefined> | undefined>;
}

/**
 * What the player actually renders when a knob is left unset — read
 * off the `:root` block in player-app/src/index.css, not off the
 * placeholder text in the editor's colour pickers. Checking against
 * the placeholders would clear palettes the player never uses.
 */
export const PLAYER_THEME_DEFAULTS: Required<ThemePalette> = {
  pageBackground: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
  cardBackground: 'rgba(255,255,255,0.1)',
  textColor: '#eeeeee',
  headingColor: '#f5f5f5',
  chromeColor: 'rgba(30,30,50,0.95)',
  accentColor: '#4ecdc4',
};

export interface ThemeContrastCheck {
  id: string;
  label: string;
  required: number;
  /**
   * Worst ratio over every page-background stop, to 2dp — or null when
   * one of the colours involved could not be parsed. A null ratio is
   * NOT a pass; see `unevaluatedThemeContrast`.
   */
  ratio: number | null;
  /** True only when the check actually ran and cleared `required`. */
  passes: boolean;
  /** The value(s) that defeated the parser, when `ratio` is null. */
  unparsed: string[];
}

/**
 * Where a colour comes from, in the order the player's own `var()`
 * fallback chains consult them. A per-component override beats the
 * global variable — both are edited in the same Theme tab, and the
 * component panels are the ones that win in the CSS, so checking only
 * the globals would clear a palette the listener never sees.
 */
type Source =
  { component: string; prop: string } | { variable: keyof ThemePalette } | { literal: string };

interface PairSpec {
  id: string;
  label: string;
  /** First value the author set wins. */
  foreground: Source[];
  /** Surfaces stacked over the page, bottom-to-top; one chain each. */
  layers: Source[][];
  required: number;
}

// How the player resolves each surface, mirroring the `var(...)`
// chains in styles.ts and index.css. Each of these was read off the
// declaration it models; a chain invented from the knob names would
// measure combinations the player never renders.

// body: `color: var(--wl-page-textColor, var(--wl-text))`.
const BODY_TEXT: Source[] = [{ component: 'page', prop: 'textColor' }, { variable: 'textColor' }];
// styles.card: `var(--wl-storyCard-background, var(--wl-card-bg, ...))`.
const CARD_BACKGROUND: Source[] = [
  { component: 'storyCard', prop: 'background' },
  { variable: 'cardBackground' },
];
// styles.card: `color: var(--wl-storyCard-textColor, var(--wl-text, inherit))`.
// Note --wl-page-textColor is NOT in this chain: a Page → Text color
// override does not reach the card.
const CARD_TEXT: Source[] = [
  { component: 'storyCard', prop: 'textColor' },
  { variable: 'textColor' },
];
// styles.settingsPanel:
// `var(--wl-settingsPanel-background, var(--wl-chrome, rgba(30,30,50,0.95)))`.
const PANEL_BACKGROUND: Source[] = [
  { component: 'settingsPanel', prop: 'background' },
  { variable: 'chromeColor' },
];
const PANEL_TEXT: Source[] = [
  { component: 'settingsPanel', prop: 'textColor' },
  { variable: 'textColor' },
];
// styles.title: `color: var(--wl-header-textColor, var(--wl-heading))`.
const HEADING_TEXT: Source[] = [
  { component: 'header', prop: 'textColor' },
  { variable: 'headingColor' },
];
// styles.header: `background: var(--wl-header-background, transparent)`.
// The default is transparent, which composites to nothing and leaves
// the page showing through — but an author who fills the header bar
// puts the title on *that*, and measuring it against the page instead
// would raise a warning they have no way to satisfy.
const HEADER_BACKGROUND: Source[] = [
  { component: 'header', prop: 'background' },
  { literal: 'transparent' },
];

/** Does this CSS value paint an image layer rather than a flat colour? */
function isImageValue(value: string): boolean {
  return /(^|[\s,])(?:repeating-)?(?:linear|radial|conic)-gradient\(|url\(/i.test(value);
}

/**
 * One component prop, or undefined if it isn't a usable string.
 *
 * Theme settings are merged into the project row verbatim — no
 * per-field validation — so any prop can hold a number, an array or an
 * object. Such a value used to be inert, because renderThemeCss skips
 * non-strings; calling `.trim()` on one here would throw inside
 * renderSmokeHtml and fail every subsequent build of that project.
 */
function componentValue(
  theme: ThemeInput | undefined,
  component: string,
  prop: string,
): string | undefined {
  const value = theme?.components?.[component]?.[prop];
  return typeof value === 'string' ? value.trim() : undefined;
}

// Functions whose output we can actually enumerate. Anything else in a
// background — `url()`, `oklch()`, `color-mix()`, a bare `var()` — is a
// surface we cannot sample.
const SAMPLABLE_FUNCTION = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient|rgba?|hsla?)$/;

// The non-colour vocabulary of a gradient: geometry, interpolation and
// the function names themselves. Whatever is left after removing these
// and every colour we parsed is, by elimination, a colour we failed to
// read.
const GRADIENT_GRAMMAR =
  /(?:repeating-)?(?:linear|radial|conic)-gradient|\b(?:to|at|in|from|circle|ellipse|top|bottom|left|right|center|closest-side|closest-corner|farthest-side|farthest-corner|srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|lab|oklab|xyz|xyz-d50|xyz-d65|hsl|hwb|lch|oklch|shorter|longer|increasing|decreasing|hue)\b/gi;
const CSS_NUMBER =
  /-?\d*\.?\d+(?:px|%|r?em|deg|rad|grad|turn|vw|vh|vmin|vmax|ex|ch|pt|pc|cm|mm|in|q)?/gi;

/**
 * Every colour the page background resolves to, or null when any part
 * of it can't be read.
 *
 * `extractColors` returns the stops it recognises and drops the rest,
 * which is fine for "show me the colours" and wrong for a *verdict*.
 * Two ways that bit:
 *
 *   - A scrim over a photo — `linear-gradient(rgba(0,0,0,.6),
 *     rgba(0,0,0,.6)), url(photo.jpg)`, the pattern the Page →
 *     Background image hint itself suggests — would be scored as if
 *     the scrim were the whole surface, with the photo ignored.
 *   - A stop written as a bare keyword outside the small NAMED map
 *     (`lightgray`, `currentColor`) or a hex length we reject
 *     (`#abcde`) has no parens, so a function-name check waves it
 *     through and the page is scored on the surviving stops alone.
 *     `linear-gradient(lightgray, #111111)` came out as 18.88:1 —
 *     a green tick for a page whose top half is white on light grey.
 *
 * So: every colour-shaped token has to parse, and whatever is left
 * over has to be gradient grammar. Partial knowledge is reported as no
 * knowledge.
 */
function samplePageStops(value: string): Rgba[] | null {
  const single = parseColor(value);
  if (single) return [single];

  const functions = [...value.matchAll(/([a-zA-Z][\w-]*)\(/g)].map((m) => m[1].toLowerCase());
  if (functions.some((fn) => !SAMPLABLE_FUNCTION.test(fn))) return null;

  const tokens = value.match(colorTokenPattern()) ?? [];
  const stops = tokens.map(parseColor);
  if (stops.length === 0 || stops.some((stop) => stop === null)) return null;

  const residue = value
    .replace(colorTokenPattern(), ' ')
    .replace(GRADIENT_GRAMMAR, ' ')
    .replace(CSS_NUMBER, ' ')
    .replace(/[(),/]/g, ' ')
    .trim();
  return residue === '' ? (stops as Rgba[]) : null;
}

/**
 * What the page actually looks like, which needs more than a fallback
 * chain because the player paints it with two declarations:
 *
 *   background:       var(--wl-page-background,      var(--wl-page-bg));
 *   background-image: var(--wl-page-backgroundImage, var(--wl-page-bg));
 *
 * The second always wins the visible layer when it resolves to a real
 * image. When it resolves to a *colour* the declaration is invalid at
 * computed-value time, so `background-image` falls back to `none` and
 * the shorthand's colour is what shows. Which means Page → Background
 * (a colour) is only visible when `--wl-page-bg` is itself a colour —
 * with the shipped default, a gradient, it is covered. Modelling this
 * as "component beats variable" would have passed a white page with
 * near-white text, and failed a dark page that renders fine.
 *
 * Both halves are returned, because the image layer can be
 * translucent: a 20%-black scrim over a dark page is dark, and
 * flattening the scrim over the browser canvas instead would have
 * called it 1.38:1 and failed a build that renders at ~14:1.
 */
interface PageSurface {
  /** The layer the text sits on — an image/gradient, or a flat colour. */
  value: string;
  /** The opaque `background-color` painted underneath it. */
  beneath: string;
}

/** `none` on a component prop means "no override", not a colour. */
function override(theme: ThemeInput | undefined, prop: string): string | undefined {
  const value = componentValue(theme, 'page', prop);
  return isSet(value) && value.toLowerCase() !== 'none' ? value : undefined;
}

function resolvePageSurface(theme: ThemeInput | undefined): PageSurface {
  // Read through `componentValue`, not `?.trim()` — see its docblock.
  const image = override(theme, 'backgroundImage');
  const color = override(theme, 'background');
  const variable = isSet(theme?.variables?.pageBackground)
    ? theme.variables.pageBackground.trim()
    : PLAYER_THEME_DEFAULTS.pageBackground;

  // The shorthand's colour. A gradient there paints as an image and
  // leaves background-color at its initial `transparent`, which shows
  // the browser's own canvas.
  const beneath = color ?? (isImageValue(variable) ? '#ffffff' : variable);

  if (image) return { value: image, beneath };
  if (isImageValue(variable)) return { value: variable, beneath };
  return { value: beneath, beneath };
}

// The surfaces text actually lands on in the player. Headings are
// rendered large (>=1.5rem), so they're held to the large-text bar.
const PAIRS: PairSpec[] = [
  {
    id: 'text-on-page',
    label: 'Body text on the page background',
    foreground: BODY_TEXT,
    layers: [],
    required: AA_NORMAL_TEXT,
  },
  {
    id: 'text-on-card',
    label: 'Body text on the story card',
    foreground: CARD_TEXT,
    layers: [CARD_BACKGROUND],
    required: AA_NORMAL_TEXT,
  },
  {
    id: 'text-on-settings-panel',
    label: 'Text on the settings panel',
    foreground: PANEL_TEXT,
    layers: [PANEL_BACKGROUND],
    required: AA_NORMAL_TEXT,
  },
  {
    // The story title and section headers sit on the page, not on the
    // card — there is no header-coloured text on the story card, so
    // measuring that combination would warn about something nobody
    // ever sees.
    id: 'heading-on-page',
    label: 'Headings on the header background',
    foreground: HEADING_TEXT,
    layers: [HEADER_BACKGROUND],
    required: AA_LARGE_TEXT,
  },
  {
    // The start button's label defaults to #1a1a2e regardless of what
    // the accent is set to (see styles.ts startBtn), so a dark accent
    // makes the one control that begins the story unreadable.
    id: 'start-button',
    label: 'Start button label on the accent fill',
    foreground: [{ component: 'startButton', prop: 'textColor' }, { literal: '#1a1a2e' }],
    layers: [[{ component: 'startButton', prop: 'background' }, { variable: 'accentColor' }]],
    required: AA_NORMAL_TEXT,
  },
];

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Walk a fallback chain and return the first value the author set,
 * or the player's own default for the global variable ending it.
 */
function resolveSource(theme: ThemeInput | undefined, chain: Source[]): string | undefined {
  for (const source of chain) {
    if ('literal' in source) return source.literal;
    if ('component' in source) {
      const value = theme?.components?.[source.component]?.[source.prop];
      // `none` means "no override", not "a value we couldn't read", so
      // it falls through to whatever is underneath.
      if (isSet(value) && value.trim().toLowerCase() !== 'none') return value.trim();
      continue;
    }
    const value = theme?.variables?.[source.variable];
    return isSet(value) ? value.trim() : PLAYER_THEME_DEFAULTS[source.variable];
  }
  return undefined;
}

/**
 * Evaluate every text/surface pair the player renders.
 *
 * A pair whose colours can't be parsed comes back with `ratio: null`
 * and `passes: false` rather than being dropped. Silently omitting it
 * would let an unreadable palette written in a syntax this doesn't
 * model render as a clean bill of health, and an affirmative pass for
 * a check that never ran is worse than no check at all.
 */
export function evaluateThemeContrast(theme: ThemeInput | undefined): ThemeContrastCheck[] {
  const results: ThemeContrastCheck[] = [];

  // The page, flattened once: its visible layer composited over the
  // background-color painted beneath it, over the browser canvas.
  const page = resolvePageSurface(theme);
  const stops = samplePageStops(page.value);
  const beneath = parseColor(page.beneath);
  const pageBases: Rgb[] | null =
    stops && beneath
      ? stops.map((stop) => composite(stop.rgb, flatten([beneath], [255, 255, 255]), stop.alpha))
      : null;
  // Name whichever half we couldn't read, so the author knows which
  // field to change.
  const pageUnreadable = stops ? page.beneath : page.value;

  for (const pair of PAIRS) {
    const unparsed: string[] = [];

    const fgValue = resolveSource(theme, pair.foreground);
    const fg = isSet(fgValue) ? parseColor(fgValue) : null;
    if (!fg) unparsed.push(fgValue ?? '(unset)');

    const layers = pair.layers.map((chain) => {
      const value = resolveSource(theme, chain);
      const parsed = isSet(value) ? parseColor(value) : null;
      if (!parsed) unparsed.push(value ?? '(unset)');
      return parsed;
    });

    // The page only matters when it can show through. The start
    // button's accent fill is opaque, so a page written as `url(...)`
    // — which we can't sample and never will be able to — has no
    // bearing on whether its label is readable, and reporting it as
    // unmeasurable there would fail the smoke check on every build
    // that uses a background image.
    const bottom = layers[0];
    const pageIsVisible = layers.length === 0 || (bottom !== null && bottom.alpha < 1);
    const bases: Rgb[] = pageIsVisible ? (pageBases ?? []) : bottom ? [bottom.rgb] : [];
    const stacked = pageIsVisible ? layers : layers.slice(1);
    if (pageIsVisible && !pageBases) unparsed.push(pageUnreadable);

    if (unparsed.length > 0) {
      results.push({
        id: pair.id,
        label: pair.label,
        required: pair.required,
        ratio: null,
        passes: false,
        unparsed,
      });
      continue;
    }

    let worst = Infinity;
    for (const base of bases) {
      let surface: Rgb = base;
      for (const layer of stacked) surface = composite(layer!.rgb, surface, layer!.alpha);
      const ink = composite(fg!.rgb, surface, fg!.alpha);
      worst = Math.min(worst, contrastRatio(ink, surface));
    }

    const ratio = Math.round(worst * 100) / 100;
    results.push({
      id: pair.id,
      label: pair.label,
      required: pair.required,
      ratio,
      passes: ratio >= pair.required,
      unparsed: [],
    });
  }

  return results;
}

/** Pairs that were measured and came up short — what a warning UI wants. */
export function failingThemeContrast(theme: ThemeInput | undefined): ThemeContrastCheck[] {
  return evaluateThemeContrast(theme).filter((c) => c.ratio !== null && !c.passes);
}

/**
 * Pairs that couldn't be measured at all. Reported separately because
 * "this is too low" and "nobody can tell whether this is too low" call
 * for different words in front of an author.
 */
export function unevaluatedThemeContrast(theme: ThemeInput | undefined): ThemeContrastCheck[] {
  return evaluateThemeContrast(theme).filter((c) => c.ratio === null);
}
