// per-component theming. Single source of truth for the
// set of components the editor can target, the CSS variables each
// one exposes, and which player surfaces they map to.
//
// This file is duplicated across the three workspaces (backend +
// frontend + player-app) because the existing `shared/` workspace
// isn't wired into their dependency trees and threading it through
// for one helper file is more friction than it's worth. The spec
// rarely changes — if you edit it here, mirror the change into
// frontend/src/api/theme-components.ts and
// player-app/src/theme-components.ts.

export type ComponentId =
  | 'page'
  | 'header'
  | 'storyCard'
  | 'choiceButton'
  | 'instructionsCard'
  | 'startButton'
  | 'settingsPanel'
  | 'resumePicker'
  | 'errorBanner';

export interface ComponentTheme {
  background?: string;
  textColor?: string;
  borderColor?: string;
  borderRadius?: string;
  borderWidth?: string;
  borderStyle?: string;
  padding?: string;
  hoverBackground?: string;
  fontFamily?: string;
  fontWeight?: string;
  letterSpacing?: string;
  textTransform?: string;
  lineHeight?: string;
  boxShadow?: string;
  backgroundImage?: string;
  // Forward-compat: a future knob doesn't require a migration.
  [key: string]: string | undefined;
}

export type ComponentTheming = Partial<Record<ComponentId, ComponentTheme>>;

export interface ComponentPropSpec {
  // CSS variable suffix; full name is `--wl-<componentId>-<key>`.
  key: string;
  label: string;
  // Drives the editor's input type:
  //   color  → HTML5 color picker + hex string
  //   length → text input (accepts `12px`, `1rem`, `50%`, `999`)
  //   number → numeric input
  //   text   → free text (used for fontFamily, fontWeight, shadows)
  //   select → drop-down of the supplied `options` (still stored as string)
  kind: 'color' | 'length' | 'number' | 'text' | 'select';
  // Default value the player CSS falls back to when the knob is
  // unset. Either a literal value or a `var(...)` reference to a
  // global variable.
  fallback: string;
  hint?: string;
  // For kind === 'select': allowed option values. Stored as strings.
  options?: string[];
}

export interface ComponentSpec {
  id: ComponentId;
  label: string;
  hint: string;
  props: ComponentPropSpec[];
}

// Shared option lists for the new select-kind knobs.
const TEXT_TRANSFORM_OPTIONS = ['none', 'uppercase', 'lowercase', 'capitalize'];
const BORDER_STYLE_OPTIONS = ['solid', 'dashed', 'dotted', 'double', 'none'];

export const COMPONENT_SPECS: ComponentSpec[] = [
  {
    id: 'page',
    label: 'Page',
    hint: 'The outermost container. Affects the body background, default text color, and base font.',
    props: [
      { key: 'background', label: 'Background', kind: 'color', fallback: 'var(--wl-page-bg)' },
      {
        key: 'backgroundImage',
        label: 'Background image / gradient',
        kind: 'text',
        fallback: 'none',
        hint: 'e.g. linear-gradient(135deg, #1a1a2e, #16213e), or url(...).',
      },
      { key: 'textColor', label: 'Text color', kind: 'color', fallback: 'var(--wl-text)' },
      { key: 'fontFamily', label: 'Body font', kind: 'text', fallback: 'var(--wl-font-body)' },
      {
        key: 'lineHeight',
        label: 'Body line height',
        kind: 'text',
        fallback: '1.6',
        hint: 'Unitless number (1.4–1.8 is typical).',
      },
    ],
  },
  {
    id: 'header',
    label: 'Header',
    hint: 'The bar at the top with the story title and the settings / restart buttons.',
    props: [
      { key: 'background', label: 'Background', kind: 'color', fallback: 'transparent' },
      { key: 'textColor', label: 'Title color', kind: 'color', fallback: 'var(--wl-heading)' },
      { key: 'fontFamily', label: 'Title font', kind: 'text', fallback: 'var(--wl-font-heading)' },
      {
        key: 'letterSpacing',
        label: 'Title letter spacing',
        kind: 'length',
        fallback: 'normal',
      },
      {
        key: 'textTransform',
        label: 'Title casing',
        kind: 'select',
        fallback: 'none',
        options: TEXT_TRANSFORM_OPTIONS,
      },
      { key: 'borderRadius', label: 'Corner radius', kind: 'length', fallback: '0' },
      { key: 'padding', label: 'Padding', kind: 'length', fallback: '0' },
      {
        key: 'borderColor',
        label: 'Button border',
        kind: 'color',
        fallback: 'rgba(255,255,255,0.2)',
      },
    ],
  },
  {
    id: 'storyCard',
    label: 'Story card',
    hint: 'The card behind the narration text on each node.',
    props: [
      { key: 'background', label: 'Background', kind: 'color', fallback: 'var(--wl-card-bg)' },
      { key: 'textColor', label: 'Text color', kind: 'color', fallback: 'var(--wl-text)' },
      { key: 'borderRadius', label: 'Corner radius', kind: 'length', fallback: '12px' },
      { key: 'padding', label: 'Padding', kind: 'length', fallback: '1.5rem' },
      { key: 'borderColor', label: 'Border color', kind: 'color', fallback: 'transparent' },
      { key: 'borderWidth', label: 'Border width', kind: 'length', fallback: '0' },
      {
        key: 'borderStyle',
        label: 'Border style',
        kind: 'select',
        fallback: 'solid',
        options: BORDER_STYLE_OPTIONS,
      },
      {
        key: 'boxShadow',
        label: 'Shadow',
        kind: 'text',
        fallback: 'none',
        hint: 'e.g. 0 6px 18px rgba(0,0,0,0.35).',
      },
      { key: 'lineHeight', label: 'Line height', kind: 'text', fallback: '1.6' },
    ],
  },
  {
    id: 'choiceButton',
    label: 'Choice button',
    hint: 'The on-screen choice options at the end of a node.',
    props: [
      {
        key: 'background',
        label: 'Background',
        kind: 'color',
        fallback: 'rgba(255,255,255,0.08)',
      },
      { key: 'textColor', label: 'Text color', kind: 'color', fallback: 'var(--wl-text)' },
      {
        key: 'hoverBackground',
        label: 'Hover background',
        kind: 'color',
        fallback: 'var(--wl-accent)',
      },
      { key: 'borderColor', label: 'Border', kind: 'color', fallback: 'rgba(255,255,255,0.15)' },
      { key: 'borderWidth', label: 'Border width', kind: 'length', fallback: '2px' },
      {
        key: 'borderStyle',
        label: 'Border style',
        kind: 'select',
        fallback: 'solid',
        options: BORDER_STYLE_OPTIONS,
      },
      { key: 'borderRadius', label: 'Corner radius', kind: 'length', fallback: '8px' },
      { key: 'padding', label: 'Padding', kind: 'length', fallback: '1rem' },
      { key: 'fontWeight', label: 'Font weight', kind: 'text', fallback: '500' },
      {
        key: 'letterSpacing',
        label: 'Letter spacing',
        kind: 'length',
        fallback: 'normal',
      },
      {
        key: 'textTransform',
        label: 'Casing',
        kind: 'select',
        fallback: 'none',
        options: TEXT_TRANSFORM_OPTIONS,
      },
      {
        key: 'boxShadow',
        label: 'Shadow',
        kind: 'text',
        fallback: 'none',
      },
    ],
  },
  {
    id: 'instructionsCard',
    label: 'Instructions card',
    hint: 'The pre-game screen with the navigation primer and the Start button.',
    props: [
      { key: 'background', label: 'Background', kind: 'color', fallback: 'var(--wl-card-bg)' },
      { key: 'textColor', label: 'Text color', kind: 'color', fallback: 'var(--wl-text)' },
      { key: 'borderRadius', label: 'Corner radius', kind: 'length', fallback: '16px' },
      { key: 'padding', label: 'Padding', kind: 'length', fallback: '2rem' },
      { key: 'borderColor', label: 'Border color', kind: 'color', fallback: 'transparent' },
      { key: 'borderWidth', label: 'Border width', kind: 'length', fallback: '0' },
      { key: 'boxShadow', label: 'Shadow', kind: 'text', fallback: 'none' },
    ],
  },
  {
    id: 'startButton',
    label: 'Start button',
    hint: 'The big call-to-action on the instructions screen.',
    props: [
      { key: 'background', label: 'Background', kind: 'color', fallback: 'var(--wl-accent)' },
      {
        key: 'hoverBackground',
        label: 'Hover background',
        kind: 'color',
        fallback: 'var(--wl-accent)',
      },
      { key: 'textColor', label: 'Text color', kind: 'color', fallback: '#1a1a2e' },
      { key: 'borderRadius', label: 'Corner radius', kind: 'length', fallback: '50px' },
      { key: 'padding', label: 'Padding', kind: 'length', fallback: '1rem 2rem' },
      { key: 'fontWeight', label: 'Font weight', kind: 'text', fallback: '600' },
      {
        key: 'letterSpacing',
        label: 'Letter spacing',
        kind: 'length',
        fallback: 'normal',
      },
      {
        key: 'textTransform',
        label: 'Casing',
        kind: 'select',
        fallback: 'none',
        options: TEXT_TRANSFORM_OPTIONS,
      },
      { key: 'boxShadow', label: 'Shadow', kind: 'text', fallback: 'none' },
    ],
  },
  {
    id: 'settingsPanel',
    label: 'Settings panel',
    hint: 'The flyout with volume + auto-continue + save slots.',
    props: [
      { key: 'background', label: 'Background', kind: 'color', fallback: 'rgba(30,30,50,0.95)' },
      { key: 'textColor', label: 'Text color', kind: 'color', fallback: 'var(--wl-text)' },
      { key: 'borderRadius', label: 'Corner radius', kind: 'length', fallback: '12px' },
      { key: 'padding', label: 'Padding', kind: 'length', fallback: '1rem 1.5rem' },
      { key: 'borderColor', label: 'Border color', kind: 'color', fallback: 'transparent' },
      { key: 'borderWidth', label: 'Border width', kind: 'length', fallback: '0' },
      { key: 'boxShadow', label: 'Shadow', kind: 'text', fallback: 'none' },
    ],
  },
  {
    id: 'resumePicker',
    label: 'Resume picker',
    hint: 'The save-slot list on the instructions screen.',
    props: [
      { key: 'background', label: 'Background', kind: 'color', fallback: 'rgba(78,205,196,0.08)' },
      { key: 'textColor', label: 'Text color', kind: 'color', fallback: 'var(--wl-text)' },
      { key: 'borderColor', label: 'Border', kind: 'color', fallback: 'rgba(78,205,196,0.4)' },
      { key: 'borderWidth', label: 'Border width', kind: 'length', fallback: '1px' },
      { key: 'borderRadius', label: 'Corner radius', kind: 'length', fallback: '8px' },
      { key: 'padding', label: 'Padding', kind: 'length', fallback: '0.75rem' },
      { key: 'boxShadow', label: 'Shadow', kind: 'text', fallback: 'none' },
    ],
  },
  {
    id: 'errorBanner',
    label: 'Error banner',
    hint: 'The red strip that surfaces audio failures or connection issues.',
    props: [
      { key: 'background', label: 'Background', kind: 'color', fallback: 'rgba(255,107,107,0.15)' },
      { key: 'borderColor', label: 'Border', kind: 'color', fallback: 'rgba(255,107,107,0.3)' },
      { key: 'borderWidth', label: 'Border width', kind: 'length', fallback: '1px' },
      { key: 'borderRadius', label: 'Corner radius', kind: 'length', fallback: '12px' },
      { key: 'padding', label: 'Padding', kind: 'length', fallback: '1rem' },
      { key: 'textColor', label: 'Text color', kind: 'color', fallback: '#ff6b6b' },
    ],
  },
];

export const COMPONENT_SPEC_BY_ID: Record<ComponentId, ComponentSpec> = Object.fromEntries(
  COMPONENT_SPECS.map((s) => [s.id, s]),
) as Record<ComponentId, ComponentSpec>;

export function componentVarName(componentId: ComponentId, key: string): string {
  return `--wl-${componentId}-${key}`;
}
