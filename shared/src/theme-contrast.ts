import {
  AA_LARGE_TEXT,
  AA_NORMAL_TEXT,
  composite,
  contrastRatio,
  extractColors,
  flatten,
  parseColor,
  type Rgb,
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

/** Does this CSS value paint an image layer rather than a flat colour? */
function isImageValue(value: string): boolean {
  return /(^|[\s,])(?:repeating-)?(?:linear|radial|conic)-gradient\(|url\(/i.test(value);
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
 */
function resolvePageSurface(theme: ThemeInput | undefined): string {
  const image = theme?.components?.page?.backgroundImage?.trim();
  const color = theme?.components?.page?.background?.trim();
  const variable = isSet(theme?.variables?.pageBackground)
    ? theme!.variables!.pageBackground!.trim()
    : PLAYER_THEME_DEFAULTS.pageBackground;

  if (isSet(image) && image.toLowerCase() !== 'none') return image;
  if (isSet(image)) {
    // Explicitly cleared: the shorthand's background-color shows. If
    // that came from a gradient it was never a colour at all, so the
    // browser canvas (white) is what's behind the text.
    if (isSet(color)) return color;
    return isImageValue(variable) ? '#ffffff' : variable;
  }
  if (isImageValue(variable)) return variable;
  return isSet(color) ? color : variable;
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
    label: 'Headings on the page background',
    foreground: HEADING_TEXT,
    layers: [],
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

  const pageValue = resolvePageSurface(theme);
  const pageStops = extractColors(pageValue);

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
    const bases: Rgb[] = pageIsVisible
      ? // A translucent page resolves over white — the browser's own
        // canvas — before anything stacks on it.
        pageStops.map((stop) => flatten([stop], [255, 255, 255]))
      : bottom
        ? [bottom.rgb]
        : [];
    const stacked = pageIsVisible ? layers : layers.slice(1);
    if (pageIsVisible && pageStops.length === 0) unparsed.push(pageValue);

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
