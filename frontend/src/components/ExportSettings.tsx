// Settings that only affect the exported build: the README shipped
// inside the zip, and the icon/colours the story installs with when a
// listener adds it to their home screen.
//
// Kept out of SettingsTab's own file because that component is already
// long and these controls share no state with it — SettingsTab just
// hands down the loaded settings and a save callback.

import { useEffect, useRef, useState } from 'react';
import { uploadProjectIcon, type ProjectSettings } from '../api/client';

interface Props {
  projectId: string;
  settings: ProjectSettings;
  /** Persists a partial patch and returns the merged result. */
  onSave: (patch: Partial<ProjectSettings>) => Promise<ProjectSettings>;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DEFAULT_COLOR = '#1a1a2e';

// Mirrors normalizeBuildLanguage in backend/src/services/build-language.ts.
// Kept in step deliberately: rejecting here means the author sees why
// their tag didn't take, instead of the build silently falling back to
// English.
const BCP47 = /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/;

// Only a convenience list for the datalist — any valid tag is accepted.
const COMMON_LANGUAGES = [
  ['en', 'English'],
  ['en-GB', 'English (UK)'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['ja', 'Japanese'],
  ['zh-Hans', 'Chinese (Simplified)'],
];

export default function ExportSettings({ projectId, settings, onSave }: Props) {
  const [readme, setReadme] = useState(settings.exportReadme ?? '');
  const [readmeSaving, setReadmeSaving] = useState(false);
  const [readmeSaved, setReadmeSaved] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);
  const [iconUploading, setIconUploading] = useState(false);
  const [iconFilename, setIconFilename] = useState(settings.appIcon?.filename ?? null);
  const [background, setBackground] = useState(settings.appIcon?.backgroundColor ?? DEFAULT_COLOR);
  const [theme, setTheme] = useState(settings.appIcon?.themeColor ?? DEFAULT_COLOR);
  const [language, setLanguage] = useState(settings.language ?? '');
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [languageSaved, setLanguageSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const languageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed when the parent swaps projects; without this the textarea
  // keeps the previous project's README.
  //
  // On a project swap ONLY — never on a fresh `settings` object.
  // SettingsTab hands one down after a save from any control in the
  // tab, and re-seeding on that clobbers whatever the author is part
  // way through here: an unsaved README draft snaps back to the stored
  // text, and a rejected language tag snaps back with its validation
  // error silently cleared, leaving the author believing it took.
  // (SettingsTab loads settings only on a project change, so there is
  // no later fetch this needs to pick up.)
  const seededProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededProjectRef.current === projectId) return;
    seededProjectRef.current = projectId;
    setReadme(settings.exportReadme ?? '');
    setIconFilename(settings.appIcon?.filename ?? null);
    setBackground(settings.appIcon?.backgroundColor ?? DEFAULT_COLOR);
    setTheme(settings.appIcon?.themeColor ?? DEFAULT_COLOR);
    setLanguage(settings.language ?? '');
    setLanguageError(null);
  }, [projectId, settings]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      if (languageTimerRef.current !== null) clearTimeout(languageTimerRef.current);
    };
  }, []);

  const flashSaved = () => {
    setReadmeSaved(true);
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setReadmeSaved(false), 2000);
  };

  const saveReadme = async () => {
    setReadmeSaving(true);
    try {
      await onSave({ exportReadme: readme });
      flashSaved();
    } finally {
      setReadmeSaving(false);
    }
  };

  // Saved on blur rather than on every keystroke: the tag is only
  // meaningful once it's complete, and "fr" is a valid prefix of
  // "fr-CA".
  const saveLanguage = async () => {
    const trimmed = language.trim();
    if (trimmed.length > 0 && !BCP47.test(trimmed)) {
      setLanguageError(
        `"${trimmed}" isn't a valid language tag. Use a code like "en", "fr" or "pt-BR".`,
      );
      return;
    }
    setLanguageError(null);
    if (trimmed === (settings.language ?? '')) return;
    try {
      await onSave({ language: trimmed });
    } catch (err) {
      // Without this the rejection lands in a discarded promise: no
      // "Saved", no error, and the input still shows the tag — so the
      // author walks away believing the language is set and ships an
      // English-tagged build.
      setLanguageError(err instanceof Error ? err.message : 'Could not save the language.');
      return;
    }
    setLanguageSaved(true);
    if (languageTimerRef.current !== null) clearTimeout(languageTimerRef.current);
    languageTimerRef.current = setTimeout(() => setLanguageSaved(false), 2000);
  };

  const saveColor = async (which: 'backgroundColor' | 'themeColor', value: string) => {
    if (!HEX.test(value)) return;
    await onSave({ appIcon: { ...settings.appIcon, [which]: value } });
  };

  const onIconChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIconError(null);
    setIconUploading(true);
    try {
      const { filename } = await uploadProjectIcon(projectId, file);
      setIconFilename(filename);
    } catch (err) {
      setIconError(err instanceof Error ? err.message : 'Icon upload failed');
    } finally {
      setIconUploading(false);
      // Clear the input so re-picking the same file fires onChange again.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <section className="settings-section">
      <h2>Export</h2>

      <h3 className="settings-subhead">Language</h3>
      <p className="text-muted">
        The language this story is written in. Exported builds carry it in{' '}
        <code>&lt;html lang&gt;</code> and the app manifest, so a screen reader reads the captions
        with the right voice and pronunciation instead of an English one. Use a language code like{' '}
        <code>en</code>, <code>fr</code> or <code>pt-BR</code>. Leave empty for English.
      </p>
      <div className="settings-row">
        <label htmlFor="export-language">Language code</label>
        <input
          id="export-language"
          type="text"
          className="settings-language-input"
          value={language}
          list="export-language-options"
          placeholder="en"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={languageError !== null}
          aria-describedby={languageError ? 'export-language-error' : undefined}
          onChange={(e) => {
            setLanguage(e.target.value);
            setLanguageError(null);
          }}
          onBlur={() => void saveLanguage()}
        />
        <datalist id="export-language-options">
          {COMMON_LANGUAGES.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </datalist>
        {languageSaved && <span className="text-muted">Saved</span>}
      </div>
      {languageError && (
        <div className="alert alert-error" role="alert" id="export-language-error">
          {languageError}
        </div>
      )}

      <h3 className="settings-subhead">README</h3>
      <p className="text-muted">
        Shipped as <code>README.md</code> inside the downloaded build. Leave this empty to use the
        default, which explains how to run the story, put it online, and install it as an app. Use{' '}
        <code>{'{{PROJECT_NAME}}'}</code> to insert the project name.
      </p>
      <textarea
        className="settings-readme-input"
        value={readme}
        rows={12}
        spellCheck
        placeholder="Leave empty to use the default README."
        onChange={(e) => setReadme(e.target.value)}
        aria-label="Exported README"
      />
      <div className="settings-row">
        <button type="button" onClick={() => void saveReadme()} disabled={readmeSaving}>
          {readmeSaving ? 'Saving…' : 'Save README'}
        </button>
        {readme.trim().length > 0 && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setReadme('');
              void onSave({ exportReadme: '' }).then(flashSaved);
            }}
            disabled={readmeSaving}
          >
            Reset to default
          </button>
        )}
        {readmeSaved && <span className="text-muted">Saved</span>}
      </div>

      <h3 className="settings-subhead">App icon</h3>
      <p className="text-muted">
        Used when a listener installs the story to their home screen. A square PNG of at least
        512×512 works best — non-square images are padded rather than cropped, so nothing gets cut
        off. Without one, builds use the default Wanderline icon.
      </p>
      <div className="settings-row">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => void onIconChange(e)}
          disabled={iconUploading}
          aria-label="App icon file"
        />
        {iconUploading && <span className="text-muted">Uploading…</span>}
        {!iconUploading && iconFilename && <span className="text-muted">Icon set</span>}
      </div>
      {iconError && (
        <div className="alert alert-error" role="alert">
          {iconError}
        </div>
      )}

      <div className="settings-row">
        <label>
          Background
          <input
            type="color"
            value={HEX.test(background) ? background : DEFAULT_COLOR}
            onChange={(e) => {
              setBackground(e.target.value);
              void saveColor('backgroundColor', e.target.value);
            }}
            aria-label="Icon background colour"
          />
        </label>
        <label>
          Theme
          <input
            type="color"
            value={HEX.test(theme) ? theme : DEFAULT_COLOR}
            onChange={(e) => {
              setTheme(e.target.value);
              void saveColor('themeColor', e.target.value);
            }}
            aria-label="App theme colour"
          />
        </label>
      </div>
    </section>
  );
}
