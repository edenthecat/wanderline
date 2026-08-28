import type React from 'react';

// Per-character passage styling.
//
// These used to carry a `text` colour too — a pastel (`#fecaca`,
// `#fef08a`, …) chosen to sit on the dark default page. Because it was
// written as an inline style it beat every theme variable *and* every
// user stylesheet, so the moment an author picked a light page — an
// ordinary choice the Theme tab offers — every character-themed
// passage rendered pastel text on near-white: 1.05:1 to 1.23:1 across
// the eight themes, against a 4.5:1 AA floor. Nothing on the page
// could rescue it.
//
// The character now owns the *surface* and the border, never the ink.
// Body text keeps coming from `--wl-text`, so it follows whatever the
// author picked and stays readable on light and dark pages alike.
export interface CharacterTheme {
  /** Translucent wash layered over the card, not a replacement for it. */
  tint: string;
  border: string;
}

export const CHARACTER_THEMES: Record<string, CharacterTheme> = {
  red: { tint: 'rgba(239,68,68,0.15)', border: '#ef4444' },
  orange: { tint: 'rgba(249,115,22,0.15)', border: '#f97316' },
  yellow: { tint: 'rgba(234,179,8,0.15)', border: '#eab308' },
  green: { tint: 'rgba(34,197,94,0.15)', border: '#22c55e' },
  blue: { tint: 'rgba(59,130,246,0.15)', border: '#3b82f6' },
  indigo: { tint: 'rgba(99,102,241,0.15)', border: '#6366f1' },
  purple: { tint: 'rgba(168,85,247,0.15)', border: '#a855f7' },
  pink: { tint: 'rgba(236,72,153,0.15)', border: '#ec4899' },
};

/** The card background variable chain the story card already uses. */
export const CARD_BACKGROUND_VAR =
  'var(--wl-storyCard-background, var(--wl-card-bg, rgba(255,255,255,0.1)))';

/**
 * Card overrides for a character theme, or an empty object when the
 * passage has no theme (or names one we don't ship).
 *
 * The tint is applied as a flat gradient layer *over* the card
 * background rather than replacing it, so an author who themed their
 * card still sees their card — previously the character wash discarded
 * `--wl-card-bg` outright.
 */
export function characterThemeCardStyle(theme: string | undefined): React.CSSProperties {
  const entry = theme ? CHARACTER_THEMES[theme] : undefined;
  if (!entry) return {};
  return {
    background: `linear-gradient(${entry.tint}, ${entry.tint}), ${CARD_BACKGROUND_VAR}`,
    borderLeft: `4px solid ${entry.border}`,
  };
}
