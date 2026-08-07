// Font helpers shared by the backend's theme renderer and the
// player's live-preview listener.
//
// These were originally private to backend/src/services/theme-render.ts.
// They live here now because the editor's live preview has to compute
// the *same* Google Fonts URL and the *same* primary weight that a full
// server render would produce. When the two implementations drifted,
// the live preview silently disagreed with the saved result: the
// backend emitted --wl-font-*-weight on a full render and the iframe
// never applied it, so authors saw weight changes do nothing until
// they hit Restart.

export interface ThemeFontConfig {
  bodyFont?: string;
  bodyFontWeights?: string[];
  headingFont?: string;
  headingFontWeights?: string[];
}

// Family names go into a Google Fonts URL + a CSS string. Strip
// everything but letters / digits / spaces / common punctuation.
export function escapeFontFamily(name: string): string {
  return name.replace(/[^A-Za-z0-9 +\-_]/g, '').trim();
}

// Quote names containing spaces so they parse as a single token.
export function fontFamilyValue(name: string): string {
  const clean = escapeFontFamily(name);
  if (!clean) return '';
  return /\s/.test(clean) ? `'${clean}'` : clean;
}

export function fontWeightsParam(weights: string[] | undefined): string {
  if (!weights || weights.length === 0) return '';
  const valid = weights.filter((w) => /^\d+$/.test(String(w)));
  if (valid.length === 0) return '';
  return `:wght@${valid.join(';')}`;
}

// Pick the first numeric weight from the author's list. Order in
// the array is the author's "primary" choice, set in the theme
// editor by promoting a weight to the front of the list.
export function primaryFontWeight(weights: string[] | undefined): string | null {
  if (!weights || weights.length === 0) return null;
  const valid = weights.filter((w) => /^\d+$/.test(String(w)));
  return valid.length > 0 ? valid[0] : null;
}

// Build the Google Fonts CSS URL for the configured fonts. Returns
// null when no fonts are set, in which case the caller skips the link.
export function googleFontsLinkUrl(theme: ThemeFontConfig | undefined): string | null {
  if (!theme) return null;
  const families: string[] = [];
  if (theme.bodyFont) {
    const name = escapeFontFamily(theme.bodyFont);
    if (name) families.push(`${name.replace(/ /g, '+')}${fontWeightsParam(theme.bodyFontWeights)}`);
  }
  if (theme.headingFont && theme.headingFont !== theme.bodyFont) {
    const name = escapeFontFamily(theme.headingFont);
    if (name)
      families.push(`${name.replace(/ /g, '+')}${fontWeightsParam(theme.headingFontWeights)}`);
  }
  if (families.length === 0) return null;
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join('&')}&display=swap`;
}
