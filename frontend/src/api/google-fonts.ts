// follow-up: searchable Google Fonts catalog.
//
// We don't hit Google's webfonts/v1 API (needs an API key) — instead
// we ship a curated list of ~110 popular families across 5 categories.
// New families can be added by hand; pull-requests welcome.
//
// FontPicker injects a single Google Fonts <link> covering every
// family in this catalog the first time the dropdown opens, so each
// row can render in its own typeface without burning N network calls.

export type FontCategory = 'sans' | 'serif' | 'display' | 'handwriting' | 'monospace';

export interface GoogleFontEntry {
  family: string;
  category: FontCategory;
}

export const CATEGORY_LABEL: Record<FontCategory, string> = {
  sans: 'Sans serif',
  serif: 'Serif',
  display: 'Display',
  handwriting: 'Handwriting',
  monospace: 'Monospace',
};

export const GOOGLE_FONTS: GoogleFontEntry[] = [
  // Sans serif — workhorses + recent favorites
  { family: 'Inter', category: 'sans' },
  { family: 'Roboto', category: 'sans' },
  { family: 'Open Sans', category: 'sans' },
  { family: 'Lato', category: 'sans' },
  { family: 'Montserrat', category: 'sans' },
  { family: 'Source Sans 3', category: 'sans' },
  { family: 'Raleway', category: 'sans' },
  { family: 'Noto Sans', category: 'sans' },
  { family: 'Poppins', category: 'sans' },
  { family: 'Nunito', category: 'sans' },
  { family: 'Nunito Sans', category: 'sans' },
  { family: 'Work Sans', category: 'sans' },
  { family: 'Quicksand', category: 'sans' },
  { family: 'Mulish', category: 'sans' },
  { family: 'Karla', category: 'sans' },
  { family: 'Manrope', category: 'sans' },
  { family: 'Public Sans', category: 'sans' },
  { family: 'DM Sans', category: 'sans' },
  { family: 'Plus Jakarta Sans', category: 'sans' },
  { family: 'Outfit', category: 'sans' },
  { family: 'Lexend', category: 'sans' },
  { family: 'Figtree', category: 'sans' },
  { family: 'Onest', category: 'sans' },
  { family: 'Geist', category: 'sans' },
  { family: 'Be Vietnam Pro', category: 'sans' },
  { family: 'Albert Sans', category: 'sans' },
  { family: 'IBM Plex Sans', category: 'sans' },
  { family: 'Fira Sans', category: 'sans' },
  { family: 'Barlow', category: 'sans' },
  { family: 'Oswald', category: 'sans' },
  { family: 'Cabin', category: 'sans' },
  { family: 'Heebo', category: 'sans' },
  { family: 'Rubik', category: 'sans' },
  { family: 'Hind', category: 'sans' },
  { family: 'Asap', category: 'sans' },
  { family: 'Ubuntu', category: 'sans' },
  { family: 'PT Sans', category: 'sans' },

  // Serif — book / editorial
  { family: 'Merriweather', category: 'serif' },
  { family: 'Playfair Display', category: 'serif' },
  { family: 'Lora', category: 'serif' },
  { family: 'PT Serif', category: 'serif' },
  { family: 'Crimson Pro', category: 'serif' },
  { family: 'EB Garamond', category: 'serif' },
  { family: 'Bitter', category: 'serif' },
  { family: 'Libre Baskerville', category: 'serif' },
  { family: 'Source Serif 4', category: 'serif' },
  { family: 'Roboto Slab', category: 'serif' },
  { family: 'Cormorant Garamond', category: 'serif' },
  { family: 'Spectral', category: 'serif' },
  { family: 'Roboto Serif', category: 'serif' },
  { family: 'Newsreader', category: 'serif' },
  { family: 'Fraunces', category: 'serif' },
  { family: 'Crimson Text', category: 'serif' },
  { family: 'Domine', category: 'serif' },
  { family: 'Cardo', category: 'serif' },
  { family: 'IBM Plex Serif', category: 'serif' },
  { family: 'Tinos', category: 'serif' },
  { family: 'Vollkorn', category: 'serif' },
  { family: 'Libre Caslon Text', category: 'serif' },
  { family: 'Old Standard TT', category: 'serif' },
  { family: 'Cinzel', category: 'serif' },

  // Display — posters / titles
  { family: 'Bebas Neue', category: 'display' },
  { family: 'Anton', category: 'display' },
  { family: 'Abril Fatface', category: 'display' },
  { family: 'Pacifico', category: 'display' },
  { family: 'Lobster', category: 'display' },
  { family: 'Righteous', category: 'display' },
  { family: 'Permanent Marker', category: 'display' },
  { family: 'Black Ops One', category: 'display' },
  { family: 'Bowlby One', category: 'display' },
  { family: 'Faster One', category: 'display' },
  { family: 'Press Start 2P', category: 'display' },
  { family: 'Major Mono Display', category: 'display' },
  { family: 'Big Shoulders Display', category: 'display' },
  { family: 'Bungee', category: 'display' },
  { family: 'Special Elite', category: 'display' },
  { family: 'Russo One', category: 'display' },
  { family: 'Alfa Slab One', category: 'display' },
  { family: 'Audiowide', category: 'display' },

  // Handwriting — script / personality
  { family: 'Caveat', category: 'handwriting' },
  { family: 'Indie Flower', category: 'handwriting' },
  { family: 'Dancing Script', category: 'handwriting' },
  { family: 'Shadows Into Light', category: 'handwriting' },
  { family: 'Kalam', category: 'handwriting' },
  { family: 'Sacramento', category: 'handwriting' },
  { family: 'Great Vibes', category: 'handwriting' },
  { family: 'Satisfy', category: 'handwriting' },
  { family: 'Homemade Apple', category: 'handwriting' },
  { family: 'Patrick Hand', category: 'handwriting' },
  { family: 'Architects Daughter', category: 'handwriting' },
  { family: 'Amatic SC', category: 'handwriting' },

  // Monospace — code-ish
  { family: 'Roboto Mono', category: 'monospace' },
  { family: 'Fira Code', category: 'monospace' },
  { family: 'Source Code Pro', category: 'monospace' },
  { family: 'JetBrains Mono', category: 'monospace' },
  { family: 'Space Mono', category: 'monospace' },
  { family: 'IBM Plex Mono', category: 'monospace' },
  { family: 'Inconsolata', category: 'monospace' },
  { family: 'Cousine', category: 'monospace' },
  { family: 'Anonymous Pro', category: 'monospace' },
  { family: 'Cutive Mono', category: 'monospace' },
];

// Build a single Google Fonts URL that pulls every family in the
// catalog at weight 400 — used by FontPicker to render each row in
// its own typeface. The URL is large but the CSS payload is metadata
// only; woff2 files only get fetched when a family actually renders.
let cachedAllFontsUrl: string | null = null;
export function buildCatalogFontsUrl(): string {
  if (cachedAllFontsUrl) return cachedAllFontsUrl;
  const families = GOOGLE_FONTS.map((f) =>
    f.family.replace(/[^A-Za-z0-9 +\-_]/g, '').replace(/ /g, '+'),
  ).filter(Boolean);
  cachedAllFontsUrl = `https://fonts.googleapis.com/css2?${families
    .map((f) => `family=${f}`)
    .join('&')}&display=swap`;
  return cachedAllFontsUrl;
}

// Case-insensitive substring filter that also matches across the
// family's category label.
export function filterFonts(query: string): GoogleFontEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return GOOGLE_FONTS;
  return GOOGLE_FONTS.filter(
    (f) =>
      f.family.toLowerCase().includes(q) || CATEGORY_LABEL[f.category].toLowerCase().includes(q),
  );
}
