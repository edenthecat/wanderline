// Per-project PWA manifest for generated builds.
//
// player-app ships a static manifest.webmanifest naming the app
// "Wanderline" with the placeholder W icons. That's right for the
// editor's preview, but every generated build is somebody else's
// story: installed to a home screen it should carry the story's name
// and the author's artwork, not ours. So the build pipeline overwrites
// dist/manifest.webmanifest with the document rendered here.
//
// Icons are resized with ffmpeg, which is already a hard dependency of
// the audio pipeline — cheaper than adding an image library for two
// thumbnails. Resizing is best-effort: a build must not fail because
// an icon didn't scale, since the manifest is still valid (and
// installable) with the default icons.

import { execFileSync } from 'child_process';
import { copyFileSync, existsSync } from 'fs';
import { join } from 'path';
import { normalizeBuildLanguage } from './build-language.js';

export interface AppIconSettings {
  /** Filename of the uploaded icon within the project's icon storage. */
  filename?: string | null;
  /** Splash-screen background. Defaults to the player's dark surface. */
  backgroundColor?: string | null;
  /** Browser/OS chrome colour. Defaults to backgroundColor. */
  themeColor?: string | null;
}

// Matches the player's own default surface (see manifest.webmanifest).
const DEFAULT_COLOR = '#1a1a2e';

// Only these land in the manifest; anything else is dropped rather
// than passed through, because the manifest is served to the OS and a
// malformed colour makes some Android launchers refuse the install
// outright.
const CSS_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function safeColor(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && CSS_HEX.test(value.trim()) ? value.trim() : fallback;
}

export interface ManifestContext {
  storyTitle: string;
  icon?: AppIconSettings;
  /** True when stageAppIcon actually produced custom icon files. */
  hasCustomIcon: boolean;
  /**
   * BCP-47 tag for the story's own language, already normalized by
   * normalizeBuildLanguage. Defaults to 'en' when the project hasn't
   * set one.
   */
  language?: string;
}

/**
 * The colour the OS paints the installed app's chrome with. Exported
 * because the generated index.html carries the same value in its
 * `theme-color` meta — the two used to disagree (the manifest had the
 * author's colour, the HTML kept the player's default navy), which
 * left mobile browser chrome and the status bar in the wrong palette.
 */
export function resolveThemeColor(icon: AppIconSettings | undefined): string {
  return safeColor(icon?.themeColor, safeColor(icon?.backgroundColor, DEFAULT_COLOR));
}

/**
 * Render the manifest for a generated build. `short_name` is capped at
 * 12 characters because that is roughly where Android and iOS start
 * truncating a home-screen label; letting a long story title through
 * produces "The Long Sto…" on the device instead of something the
 * author chose.
 */
export function renderManifest({
  storyTitle,
  icon,
  hasCustomIcon,
  language,
}: ManifestContext): string {
  const background = safeColor(icon?.backgroundColor, DEFAULT_COLOR);
  const theme = resolveThemeColor(icon);
  const name = storyTitle.trim() || 'Audio narrative';
  const shortName = name.length > 12 ? `${name.slice(0, 11).trimEnd()}…` : name;
  const iconBase = hasCustomIcon ? './icons/app' : './icon';
  const lang = normalizeBuildLanguage(language);
  // The trailing phrase is English, and a manifest string has no way
  // to mark a sub-span the way `<span lang>` can in HTML — so a French
  // story would ship `lang: "fr"` alongside "Mon Histoire — an audio
  // narrative.", and whatever surface shows the install prompt would
  // read that tail with French phonetics. Non-English builds get the
  // bare title instead.
  const description = lang.toLowerCase().startsWith('en') ? `${name} — an audio narrative.` : name;

  return `${JSON.stringify(
    {
      name,
      short_name: shortName,
      description,
      lang,
      start_url: './',
      scope: './',
      display: 'standalone',
      display_override: ['standalone', 'minimal-ui'],
      // WCAG 1.3.4: never lock the installed story to one orientation.
      // This used to be 'portrait', which meant a listener whose device
      // is physically fixed in landscape — a wheelchair-mounted tablet,
      // a keyboard case, a car dock — could not turn the story the right
      // way up. The player's layout works in both orientations.
      orientation: 'any',
      background_color: background,
      theme_color: theme,
      icons: [
        {
          src: `${iconBase}-192.png`,
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
        {
          src: `${iconBase}-512.png`,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any',
        },
        // A maskable copy so Android can crop to the launcher's shape
        // instead of drawing the icon in a white circle.
        {
          src: `${iconBase}-512.png`,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/**
 * Scale the author's icon into the two sizes the manifest references.
 *
 * Letterboxes rather than crops (`force_original_aspect_ratio=decrease`
 * + `pad`) so a non-square upload keeps all of its artwork; cropping an
 * icon usually beheads whatever the author centred in it.
 *
 * @returns true when both sizes were written and the manifest should
 * point at them. Any failure returns false, leaving the build to fall
 * back to the player's default icons.
 */
export function stageAppIcon(
  sourcePath: string,
  outputDir: string,
  icon: AppIconSettings | undefined,
): boolean {
  if (!existsSync(sourcePath)) return false;
  const background = safeColor(icon?.backgroundColor, DEFAULT_COLOR);
  try {
    for (const size of [192, 512]) {
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-i',
          sourcePath,
          '-vf',
          `scale=${size}:${size}:force_original_aspect_ratio=decrease,` +
            `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=${background}`,
          '-frames:v',
          '1',
          join(outputDir, `app-${size}.png`),
        ],
        { stdio: 'pipe' },
      );
    }
    return true;
  } catch {
    return false;
  }
}

/** Copy the player's default icons alongside a build that has no custom art. */
export function copyDefaultIcons(playerDistDir: string, outputDir: string): void {
  for (const size of [192, 512]) {
    const src = join(playerDistDir, `icon-${size}.png`);
    if (existsSync(src)) copyFileSync(src, join(outputDir, `icon-${size}.png`));
  }
}
