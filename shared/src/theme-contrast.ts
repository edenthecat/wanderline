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
  chromeColor: 'rgba(255,255,255,0.05)',
  accentColor: '#4ecdc4',
};

export interface ThemeContrastCheck {
  id: string;
  label: string;
  /** Worst ratio over every page-background stop, to 2dp. */
  ratio: number;
  required: number;
  passes: boolean;
}

interface PairSpec {
  id: string;
  label: string;
  /** A palette key, or a literal colour the player hardcodes. */
  foreground: keyof ThemePalette | { literal: string };
  /** Surfaces stacked over the page, bottom-to-top. */
  layers: Array<keyof ThemePalette>;
  required: number;
}

// The surfaces text actually lands on in the player. Headings are
// rendered large (>=1.5rem), so they're held to the large-text bar.
const PAIRS: PairSpec[] = [
  {
    id: 'text-on-page',
    label: 'Body text on the page background',
    foreground: 'textColor',
    layers: [],
    required: AA_NORMAL_TEXT,
  },
  {
    id: 'text-on-card',
    label: 'Body text on the story card',
    foreground: 'textColor',
    layers: ['cardBackground'],
    required: AA_NORMAL_TEXT,
  },
  {
    id: 'text-on-chrome',
    label: 'Body text on the player chrome',
    foreground: 'textColor',
    layers: ['chromeColor'],
    required: AA_NORMAL_TEXT,
  },
  {
    id: 'heading-on-page',
    label: 'Headings on the page background',
    foreground: 'headingColor',
    layers: [],
    required: AA_LARGE_TEXT,
  },
  {
    id: 'heading-on-card',
    label: 'Headings on the story card',
    foreground: 'headingColor',
    layers: ['cardBackground'],
    required: AA_LARGE_TEXT,
  },
  {
    // The start button paints its label #1a1a2e regardless of what the
    // accent is set to (see styles.ts startBtn), so a dark accent
    // makes the one control that begins the story unreadable.
    id: 'start-button',
    label: 'Start button label on the accent fill',
    foreground: { literal: '#1a1a2e' },
    layers: ['accentColor'],
    required: AA_NORMAL_TEXT,
  },
];

/** Fall back to the player default for any knob the author left blank. */
export function resolvePalette(palette: ThemePalette | undefined): Required<ThemePalette> {
  const out = { ...PLAYER_THEME_DEFAULTS };
  for (const key of Object.keys(PLAYER_THEME_DEFAULTS) as Array<keyof ThemePalette>) {
    const value = palette?.[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * Evaluate every text/surface pair the player renders.
 *
 * Pairs whose colours we can't parse (a `var()`, an unsupported colour
 * function) are omitted rather than guessed at — a check nobody can
 * verify is worse than no check.
 */
export function evaluateThemeContrast(palette: ThemePalette | undefined): ThemeContrastCheck[] {
  const resolved = resolvePalette(palette);
  // A gradient page is checked at every stop: text has to stay
  // readable the whole way down, not just at the top.
  const pageStops = extractColors(resolved.pageBackground);
  if (pageStops.length === 0) return [];

  const results: ThemeContrastCheck[] = [];
  for (const pair of PAIRS) {
    const fgValue =
      typeof pair.foreground === 'object' ? pair.foreground.literal : resolved[pair.foreground];
    const fg = parseColor(fgValue);
    if (!fg) continue;

    const layers = pair.layers.map((key) => parseColor(resolved[key]));
    if (layers.some((l) => l === null)) continue;

    let worst = Infinity;
    for (const stop of pageStops) {
      // A translucent page background resolves over white — the
      // browser's own canvas — before anything stacks on it.
      let surface: Rgb = flatten([stop], [255, 255, 255]);
      for (const layer of layers) surface = composite(layer!.rgb, surface, layer!.alpha);
      const ink = composite(fg.rgb, surface, fg.alpha);
      worst = Math.min(worst, contrastRatio(ink, surface));
    }

    const ratio = Math.round(worst * 100) / 100;
    results.push({
      id: pair.id,
      label: pair.label,
      ratio,
      required: pair.required,
      passes: ratio >= pair.required,
    });
  }
  return results;
}

/** Just the pairs that fail — what a warning UI wants. */
export function failingThemeContrast(palette: ThemePalette | undefined): ThemeContrastCheck[] {
  return evaluateThemeContrast(palette).filter((c) => !c.passes);
}
