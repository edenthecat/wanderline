import {
  AA_LARGE_TEXT,
  AA_NON_TEXT,
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
  /**
   * Author CSS. renderThemeCss appends it verbatim *after* the `:root`
   * block, and the Theme tab tells authors their selectors win — so it
   * outranks every variable measured here, `!important` or not.
   */
  customCss?: string;
}

/**
 * Whether author CSS could be overriding what the pairs above measured.
 *
 * Nothing here parses that CSS, and a single
 * `body { color: #fff !important }` is enough to make a measured 13:1
 * page unreadable. The pairs are still worth reporting — they are what
 * the knobs produce — but a silent list and a green tick both read as
 * "your palette is fine", which is a claim this module cannot make
 * over arbitrary CSS. Callers that state a verdict say so alongside it.
 *
 * Deliberately not folded into the checks themselves: marking every
 * pair unmeasured whenever custom CSS exists would delete the feature
 * for the authors most likely to need it.
 */
export function themeContrastMayBeOverridden(theme: ThemeInput | undefined): boolean {
  return typeof theme?.customCss === 'string' && theme.customCss.trim().length > 0;
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

// styles.choice: `color: var(--wl-choiceButton-textColor, var(--wl-text, #eee))`
// / `background: var(--wl-choiceButton-background, rgba(255,255,255,0.08))`.
// Sits directly on the page (a sibling of the story card, not nested
// in it), same pattern as HEADING_TEXT/HEADER_BACKGROUND above.
const CHOICE_BUTTON_TEXT: Source[] = [
  { component: 'choiceButton', prop: 'textColor' },
  { variable: 'textColor' },
];
const CHOICE_BUTTON_BACKGROUND: Source[] = [
  { component: 'choiceButton', prop: 'background' },
  { literal: 'rgba(255,255,255,0.08)' },
];

// styles.instructionsCard: `var(--wl-instructionsCard-background, var(--wl-card-bg, ...))`
// / `color: var(--wl-instructionsCard-textColor, var(--wl-text, inherit))`.
// The pre-game screen's own card, directly on the page.
const INSTRUCTIONS_CARD_TEXT: Source[] = [
  { component: 'instructionsCard', prop: 'textColor' },
  { variable: 'textColor' },
];
const INSTRUCTIONS_CARD_BACKGROUND: Source[] = [
  { component: 'instructionsCard', prop: 'background' },
  { variable: 'cardBackground' },
];

// styles.resumePicker: `background: var(--wl-resumePicker-background, rgba(78,205,196,0.08))`
// / `color: var(--wl-resumePicker-textColor, var(--wl-text, inherit))`.
// Rendered nested INSIDE the instructions card (App.tsx), not as a
// sibling — the layer chain has to stack both, page → instructions
// card → resume picker, or a translucent picker background measured
// against the page alone would miss whatever the card underneath it
// contributes.
const RESUME_PICKER_TEXT: Source[] = [
  { component: 'resumePicker', prop: 'textColor' },
  { variable: 'textColor' },
];
const RESUME_PICKER_BACKGROUND: Source[] = [
  { component: 'resumePicker', prop: 'background' },
  { literal: 'rgba(78,205,196,0.08)' },
];

// styles.errorBanner: `background: var(--wl-errorBanner-background, rgba(255,107,107,0.15))`
// / `color: var(--wl-errorBanner-textColor, #ff6b6b)`. A sibling of the
// story card, not nested in it (App.tsx renders it after the card's
// closing tag).
const ERROR_BANNER_TEXT: Source[] = [
  { component: 'errorBanner', prop: 'textColor' },
  { literal: '#ff6b6b' },
];
const ERROR_BANNER_BACKGROUND: Source[] = [
  { component: 'errorBanner', prop: 'background' },
  { literal: 'rgba(255,107,107,0.15)' },
];

// index.css .wl-password-input:focus-visible: `outline: 2px solid
// var(--wl-accent, #4ecdc4)`. Not theme-editable itself (a fixed
// index.css rule, not a var() chain an author's Theme tab touches),
// but the colour IT USES is — an accent chosen to match the page would
// make the one focus indicator on the control gating the whole story
// disappear, and nothing else in this module was checking that pair.
// The ring sits on the password card's own fixed translucent wash,
// itself over the page.
const FOCUS_RING: Source[] = [{ variable: 'accentColor' }];
const PASSWORD_CARD_BACKGROUND: Source[] = [{ literal: 'rgba(255,255,255,0.1)' }];

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

  // The trailing `(` is captured as an OPTIONAL group rather than
  // required. Written as `([a-zA-Z][\w-]*)\(`, a failed match restarts
  // the scan INSIDE the identifier it just consumed, so a theme value
  // that is a long run of word characters with no paren — which an
  // author can set — costs O(n^2). Consuming the identifier either way
  // and testing whether a paren followed keeps it to one pass.
  const functions = [...value.matchAll(/([a-zA-Z][\w-]*)(\()?/g)]
    .filter((m) => m[2] !== undefined)
    .map((m) => m[1].toLowerCase());
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
  /**
   * True when `value` cannot be trusted even though it happens to be
   * syntactically parseable — e.g. a `background-image` value whose
   * grammar this module cannot fully validate. Forces the caller to
   * treat the pair as unmeasured rather than measuring the wrong
   * thing with full confidence.
   */
  indeterminate?: boolean;
}

/**
 * Split a CSS value list on top-level commas only — one inside a
 * function's parens (a gradient's colour stops, an rgba() alpha) is
 * not a layer boundary. Paren-depth tracking, not a regex: the
 * comma-separated grammar this reads is author-controlled and a
 * backtracking split here would be the same class of bug the number
 * grammars above were rewritten to avoid.
 */
function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

/**
 * The trailing flat colour of a multi-layer background value, if
 * there is one — CSS only allows a plain colour on the LAST
 * comma-separated layer. `linear-gradient(rgba(0,0,0,.2),
 * rgba(0,0,0,.2)), #111111` paints that gradient over `#111`, not over
 * the white canvas a single-layer value assumes.
 *
 * Returns null both for a single-layer value (nothing to find) and for
 * a multi-layer value whose last segment is itself image-shaped
 * (nothing IS painted underneath it — the canvas assumption is
 * correct there), so callers only get a colour back when one is
 * actually present to find.
 */
function trailingLayerColor(value: string): string | null {
  const layers = splitTopLevel(value, ',');
  if (layers.length < 2) return null;
  const last = layers[layers.length - 1].trim();
  return last && !isImageValue(last) ? last : null;
}

/** Does this value contain a `var()` reference this module cannot resolve? */
function hasUnresolvedVar(value: string): boolean {
  return /var\(/i.test(value);
}

function resolvePageSurface(theme: ThemeInput | undefined): PageSurface {
  // Read through `componentValue`, not `?.trim()` — see its docblock.
  const colorRaw = componentValue(theme, 'page', 'background');
  // `background: none` is valid CSS for the shorthand — `none` is an
  // acceptable `<bg-image>` token on its own, so it clears
  // background-image and leaves background-color at its initial
  // `transparent`. That is a real, renderable state (the browser
  // canvas shows through), not "no override": treating it as unset —
  // what every other component prop's `none` means in this module —
  // measured the dark global default against a page an author who
  // wrote this never gets.
  const colorCleared = isSet(colorRaw) && colorRaw.trim().toLowerCase() === 'none';
  const colorOverride = isSet(colorRaw) && !colorCleared ? colorRaw.trim() : undefined;
  // NOT the same treatment: on THIS field `none` is not "unset" either,
  // it is the author switching the image layer off, and it has to
  // reach the isImageValue test below to do that. renderThemeCss emits
  // every non-empty prop verbatim, so `--wl-page-backgroundImage: none`
  // is what the player really gets.
  const imageOverride = componentValue(theme, 'page', 'backgroundImage');
  const variable = isSet(theme?.variables?.pageBackground)
    ? theme.variables.pageBackground.trim()
    : PLAYER_THEME_DEFAULTS.pageBackground;

  // `background: <shorthand>`. A gradient here paints as an image and
  // leaves background-color at its initial `transparent`, which shows
  // the browser's own canvas — so the colour beneath is the canvas,
  // not the gradient. Testing the *override* and not just the variable
  // matters: the Page → Background knob is free text, and a gradient
  // typed into it used to land in `beneath`, where parseColor can only
  // return null. The whole page then came back "couldn't measure this"
  // for a surface samplePageStops reads perfectly well.
  const shorthand = colorCleared ? 'transparent' : (colorOverride ?? variable);

  // The shorthand's OWN `background-color` sub-property. This is a
  // separate concept from the image LAYER below: the full `background:`
  // shorthand grammar allows a plain colour as the last comma-separated
  // layer (that's what lets an author combine an image and a colour in
  // one field), so the colour underneath everything comes from here
  // regardless of what `background-image` later decides to paint on
  // top of it.
  const shorthandTrailingColor = trailingLayerColor(shorthand);
  const backgroundColor =
    shorthandTrailingColor ?? (isImageValue(shorthand) ? 'transparent' : shorthand);

  // `background-image: <value>`, declared after the shorthand, so it
  // decides the image layer outright. A value that is not an image is
  // invalid at computed-value time and computes to `none` — which
  // wipes the shorthand's image rather than painting itself. Trusting
  // this field to be an image signed off on white-on-white: a colour
  // typed into Page → Background image was scored as the surface the
  // text sits on, while the player showed the background-color
  // underneath it.
  const imageDecl = isSet(imageOverride) ? imageOverride : variable;
  const hasImageLayer = isImageValue(imageDecl);
  // Unlike the full shorthand, `background-image` alone has no colour
  // sub-property — every comma-separated layer must itself be an
  // image, or the WHOLE declaration is invalid at computed-value time.
  // Per the custom-properties spec, an invalid declaration still wins
  // its slot in the cascade; it just resolves to the property's
  // initial value instead of its literal text — so this isn't merely
  // unmeasurable, it is a background-image the browser genuinely
  // renders as `none`, discarding whatever image layer the shorthand
  // above implicitly carried. Same end state as the field being unset.
  const imageTrailingColor = hasImageLayer ? trailingLayerColor(imageDecl) : null;
  const imageDeclInvalid = imageTrailingColor !== null;

  if (hasImageLayer && !imageDeclInvalid) {
    // A real image sits on top of `backgroundColor` — two genuinely
    // distinct layers, composited once each by evaluateThemeContrast's
    // stops-over-beneath pipeline.
    return { value: imageDecl, beneath: backgroundColor };
  }

  // A bare `var(...)` can resolve to a real image through the author's
  // own custom CSS — this module has no way to know, unlike the case
  // above, which CSS itself resolves to `none` regardless of anything
  // external. Neither "an image we can sample" nor "not an image, fall
  // through to the flat colour" is true here, so it is reported as
  // genuinely indeterminate rather than guessed either way.
  if (!hasImageLayer && !imageDeclInvalid && hasUnresolvedVar(imageDecl)) {
    return { value: imageDecl, beneath: backgroundColor, indeterminate: true };
  }

  // No image layer (including the invalid-image-declaration case
  // above): backgroundColor is the only thing painted, straight onto
  // the canvas. Reporting it as ALSO `beneath` — what this used to do —
  // told the caller's stops-over-beneath pipeline there were two layers
  // of the same colour, double-compositing a translucent value: white
  // text on rgba(0,0,0,.5) measured against roughly #404040 (composited
  // twice) instead of the ~#808080 the browser actually paints
  // (composited once).
  return { value: backgroundColor, beneath: '#ffffff' };
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
  {
    id: 'text-on-choice-button',
    label: 'Choice button label',
    foreground: CHOICE_BUTTON_TEXT,
    layers: [CHOICE_BUTTON_BACKGROUND],
    required: AA_NORMAL_TEXT,
  },
  {
    id: 'text-on-instructions-card',
    label: 'Text on the instructions card',
    foreground: INSTRUCTIONS_CARD_TEXT,
    layers: [INSTRUCTIONS_CARD_BACKGROUND],
    required: AA_NORMAL_TEXT,
  },
  {
    id: 'text-on-resume-picker',
    label: 'Text on a resume-from-save row',
    foreground: RESUME_PICKER_TEXT,
    layers: [INSTRUCTIONS_CARD_BACKGROUND, RESUME_PICKER_BACKGROUND],
    required: AA_NORMAL_TEXT,
  },
  {
    id: 'text-on-error-banner',
    label: 'Error banner text',
    foreground: ERROR_BANNER_TEXT,
    layers: [ERROR_BANNER_BACKGROUND],
    required: AA_NORMAL_TEXT,
  },
  {
    // Non-text: this is the visible boundary of a focus indicator, not
    // a body of text, so it's held to the graphical/UI-component floor
    // (WCAG 1.4.11) rather than the text ratios above.
    id: 'password-focus-ring',
    label: 'Password field focus ring',
    foreground: FOCUS_RING,
    layers: [PASSWORD_CARD_BACKGROUND],
    required: AA_NON_TEXT,
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
      if (!isSet(value)) continue;
      // Earlier code treated `none` here the same as unset ("no
      // override, fall through to whatever is underneath"), which is
      // only true for the ONE prop with dedicated background-layer
      // modelling above (page.background). renderThemeCss forwards
      // `none` verbatim for every other prop too, and what it means
      // once rendered depends on the prop: valid-and-transparent for a
      // background, invalid-at-computed-value-time (falls back to
      // inherited/initial, not to this chain's next link) for a text
      // colour — two different outcomes this generic resolver has no
      // way to distinguish. Returning it here rather than special-
      // casing it lets it reach parseColor, which correctly fails on
      // it, so the pair is reported as unmeasured instead of silently
      // measuring whatever this chain's NEXT source happened to be —
      // which was never what the player actually renders either way.
      return value.trim();
    }
    const value = theme?.variables?.[source.variable];
    return isSet(value) ? value.trim() : PLAYER_THEME_DEFAULTS[source.variable];
  }
  return undefined;
}

// Interior samples per stop-to-stop segment. A CSS gradient interpolates
// continuously, and the worst-contrast point can sit anywhere along
// that interpolation, not only at a stop: black->white with mid-grey
// text clears AA at both ends and crosses near 1:1 somewhere in the
// middle. Sampling only the stops — what this used to do — missed
// exactly that case. 8 is a fixed, cheap-enough count for text-sized
// palettes (a handful of stops); real CSS stop *positions* aren't
// modelled here either (see samplePageStops), so even spacing between
// extracted stops is already the model's working assumption and this
// keeps that assumption rather than inventing new precision the rest
// of the module doesn't have.
const GRADIENT_SAMPLES_PER_SEGMENT = 8;

function interpolateRgba(a: Rgba, b: Rgba, t: number): Rgba {
  return {
    rgb: [0, 1, 2].map((i) => a.rgb[i] + (b.rgb[i] - a.rgb[i]) * t) as Rgb,
    alpha: a.alpha + (b.alpha - a.alpha) * t,
  };
}

/**
 * Insert interior samples between every adjacent pair of extracted
 * gradient stops. A single-stop (flat colour) list passes through
 * unchanged — there is nothing to interpolate.
 */
function interpolateGradientStops(stops: Rgba[]): Rgba[] {
  if (stops.length < 2) return stops;
  const out: Rgba[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    out.push(stops[i]);
    for (let step = 1; step < GRADIENT_SAMPLES_PER_SEGMENT; step++) {
      out.push(interpolateRgba(stops[i], stops[i + 1], step / GRADIENT_SAMPLES_PER_SEGMENT));
    }
  }
  out.push(stops[stops.length - 1]);
  return out;
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
  // `indeterminate` overrides whatever samplePageStops would say:
  // resolvePageSurface sets it when `page.value` is syntactically
  // parseable but structurally untrustworthy (a background-image value
  // with a trailing colour the grammar does not allow there) — a case
  // the purely syntactic stop-extraction below cannot itself detect.
  const stops = page.indeterminate ? null : samplePageStops(page.value);
  const beneath = parseColor(page.beneath);
  const pageBases: Rgb[] | null =
    stops && beneath
      ? interpolateGradientStops(stops).map((stop) =>
          composite(stop.rgb, flatten([beneath], [255, 255, 255]), stop.alpha),
        )
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

    // Compare before rounding. Rounding first certified everything in
    // [4.495, 4.5) as clearing AA — a 4.4961:1 page reported "4.5:1,
    // passes" — which is the checker handing out the exact false green
    // tick it exists to prevent. 2dp is a display concern only.
    const passes = worst >= pair.required;
    results.push({
      id: pair.id,
      label: pair.label,
      required: pair.required,
      ratio: Math.round(worst * 100) / 100,
      passes,
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
