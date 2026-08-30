// README shipped inside every generated build.
//
// Authors can override the whole document from Settings → Export
// (`settings.exportReadme`); when they haven't, we render the default
// template below. Either way the text goes through the same
// placeholder pass, so an override doesn't lose the project name and
// a default doesn't hardcode it.
//
// The install-as-a-web-app section is deliberately part of the DEFAULT
// template rather than appended unconditionally: an author who has
// written their own README owns the whole document, and silently
// stapling our prose onto it would be surprising. `renderBuildReadme`
// instead guarantees the guidance reaches listeners through the player
// UI itself (see InstallGuidance in player-app), which an override
// can't switch off.

export interface ReadmeContext {
  projectName: string;
  /** Author override from project settings, if any. */
  template?: string | null;
}

/** Placeholders an author may use in a custom README. */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Z_]+)\s*\}\}/g;

export const DEFAULT_README_TEMPLATE = `# {{PROJECT_NAME}}

An audio narrative. Put on headphones, press play, and choose where the
story goes.

## Install it as an app (recommended)

This plays best installed to your home screen: it runs full-screen, keeps
working when you lose signal, and holds onto your place between sessions.
Playing in a normal browser tab works, but audio is more likely to stall on
a patchy connection and some phones will pause it when you lock the screen.

- **iPhone / iPad (Safari):** tap **Share**, then **Add to Home Screen**.
- **Android (Chrome):** tap the **three-dot browser menu (⋮)**, then **Install app** or **Add to Home screen**.
- **Desktop (Chrome / Edge):** click the **install** icon at the right-hand
  end of the address bar.

Once installed, open it from the home-screen icon rather than the browser.
Then use **Download for offline** inside the app to pull every audio file
down in advance — after that it plays with no connection at all.

## Run it locally

These are plain static files, but they need to be served over HTTP rather
than opened directly — offline support and audio caching don't work from a
\`file://\` URL. From a terminal in this folder:

\`\`\`
npx serve
\`\`\`

Then open the address it prints (usually http://localhost:3000).

## Put it online

Upload this entire folder to any static host:

- **Netlify** — drag and drop the folder at netlify.com/drop
- **GitHub Pages** — push to a repo and enable Pages
- **Cloudflare Pages / Vercel** — point at the folder, no build command

There's no build step; these files are ready to serve as-is. Serve them over
HTTPS — installing as an app and offline playback both require a secure
origin.

## What's in here

- \`index.html\` — the player
- \`story.json\` — the story graph and its settings
- \`audio/\` — every voiceover, music and indicator file
- \`smoke.html\` — open this to verify every node and audio file resolves
`;

/**
 * Render the README for a build. Unknown placeholders are left
 * untouched rather than replaced with an empty string — a literal
 * `{{FOO}}` surviving into the output is a far better signal to the
 * author than text that silently vanished.
 */
export function renderBuildReadme({ projectName, template }: ReadmeContext): string {
  const values: Record<string, string> = {
    PROJECT_NAME: projectName,
  };
  const source =
    typeof template === 'string' && template.trim().length > 0 ? template : DEFAULT_README_TEMPLATE;
  return source.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );
}
