// Ordering helpers for the theme editor's font-weight lists.
//
// Order carries meaning: the backend's primaryFontWeight takes the
// first numeric entry of the array and emits it as --wl-font-*-weight,
// which is the weight the player actually renders. Everything else in
// the list is still fetched from Google Fonts so customCss can reach
// it, but only the first entry becomes the default.
//
// These live outside ThemeTab so the ordering rules can be tested
// directly rather than through a component that needs the settings API
// stubbed.

/**
 * Add or remove a weight, preserving the order of the rest.
 *
 * Deliberately does NOT sort. It used to end in `.sort()`, which meant
 * the primary was always whichever weight happened to be numerically
 * lowest: an author who checked 400 and 700 got 400 as their body
 * weight with no way to choose 700 short of unchecking 400. New weights
 * append so an existing primary keeps its slot.
 */
export function toggleWeight(weights: string[] | undefined, weight: string): string[] {
  const current = weights ?? [];
  if (current.includes(weight)) return current.filter((w) => w !== weight);
  return [...current, weight];
}

/**
 * Promote a weight to primary by moving it to the front.
 *
 * The relative order of the remaining weights is preserved, so
 * promoting twice doesn't shuffle the rest of the list.
 */
export function promoteWeight(weights: string[] | undefined, weight: string): string[] {
  const current = weights ?? [];
  if (!current.includes(weight)) return current;
  return [weight, ...current.filter((w) => w !== weight)];
}
