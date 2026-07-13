import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  fetchProjectSettings,
  updateProjectSettings,
  type ProjectTheme,
  type ThemeVariables,
} from '../api/client';
import {
  COMPONENT_SPECS,
  type ComponentId,
  type ComponentSpec,
  type ComponentPropSpec,
} from '@wanderline/shared';
import FontPicker from './FontPicker';

interface Props {
  projectId: string;
}

interface VariableKnob {
  key: keyof ThemeVariables;
  label: string;
  hint: string;
  defaultValue: string;
}

// global knobs (page-wide).
const VARIABLE_KNOBS: VariableKnob[] = [
  {
    key: 'pageBackground',
    label: 'Page background',
    hint: 'Body backdrop',
    defaultValue: '#1a1a2e',
  },
  {
    key: 'cardBackground',
    label: 'Card background',
    hint: 'Story card / instructions panel',
    defaultValue: '#262640',
  },
  { key: 'textColor', label: 'Body text', hint: 'Narration + captions', defaultValue: '#f5f5f5' },
  {
    key: 'accentColor',
    label: 'Accent',
    hint: 'Buttons, focus rings, highlights',
    defaultValue: '#4ecdc4',
  },
  {
    key: 'headingColor',
    label: 'Headings',
    hint: 'Story title, section headers',
    defaultValue: '#f5f5f5',
  },
  {
    key: 'chromeColor',
    label: 'Chrome',
    hint: 'Player UI surfaces (header, settings panel)',
    defaultValue: '#1f2040',
  },
  {
    key: 'iconColor',
    label: 'Icons',
    hint: 'Tint every iconoir SVG in the player (play, settings, restart, …)',
    defaultValue: '#4ecdc4',
  },
];

const COMMON_WEIGHTS = ['400', '500', '600', '700'];

function isHexish(v: string): boolean {
  return /^#[0-9a-f]{3,8}$/i.test(v.trim());
}

function ComponentPropEditor({
  spec,
  propSpec,
  value,
  onChange,
}: {
  spec: ComponentSpec;
  propSpec: ComponentPropSpec;
  value: string | undefined;
  onChange: (next: string) => void;
}) {
  const current = value ?? '';
  if (propSpec.kind === 'color') {
    return (
      <label className="bluetooth-option">
        <span>
          <strong>{propSpec.label}</strong>
          {propSpec.hint && <p className="text-sm text-muted">{propSpec.hint}</p>}
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <input
            type="color"
            value={isHexish(current) ? current : '#000000'}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`${spec.label} ${propSpec.label} color picker`}
          />
          <input
            type="text"
            value={current}
            onChange={(e) => onChange(e.target.value)}
            placeholder={propSpec.fallback}
            style={{ width: 130, fontFamily: 'monospace', fontSize: 12 }}
            aria-label={`${spec.label} ${propSpec.label} value`}
          />
        </span>
      </label>
    );
  }
  if (propSpec.kind === 'select') {
    return (
      <label className="bluetooth-option">
        <span>
          <strong>{propSpec.label}</strong>
          {propSpec.hint && <p className="text-sm text-muted">{propSpec.hint}</p>}
        </span>
        <select
          value={current}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 160 }}
          aria-label={`${spec.label} ${propSpec.label} value`}
        >
          <option value="">{propSpec.fallback} (default)</option>
          {(propSpec.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="bluetooth-option">
      <span>
        <strong>{propSpec.label}</strong>
        {propSpec.hint && <p className="text-sm text-muted">{propSpec.hint}</p>}
      </span>
      <input
        type={propSpec.kind === 'number' ? 'number' : 'text'}
        value={current}
        onChange={(e) => onChange(e.target.value)}
        placeholder={propSpec.fallback}
        style={{ width: 160, fontFamily: 'monospace', fontSize: 12 }}
        aria-label={`${spec.label} ${propSpec.label} value`}
      />
    </label>
  );
}

export default function ThemeTab({ projectId }: Props) {
  const [theme, setTheme] = useState<ProjectTheme>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<ComponentId>>(new Set());
  const [activeComponent, setActiveComponent] = useState<ComponentId | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchProjectSettings(projectId)
      .then(({ settings }) => {
        if (cancelled) return;
        setTheme(settings.theme ?? {});
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load theme');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // push the live theme to the iframe on every change.
  // Debounce so dragging a color picker doesn't fire 200 postMessages.
  // The iframe is same-origin in this app, so target our own origin
  // rather than `'*'` to keep theme state out of any cross-origin
  // embed someone might wrap us in.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage(
        { type: 'wanderline:theme-update', theme },
        window.location.origin,
      );
    }, 60);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [theme]);

  // Listen for inspect clicks from the iframe → open the matching
  // panel + scroll into view. Only accept messages from our own
  // iframe's contentWindow on our own origin so another window or
  // tab can't spoof inspector events.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'wanderline:inspect') {
        const id = event.data.componentId as ComponentId;
        if (!id) return;
        setActiveComponent(id);
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        setTimeout(() => {
          const panel = document.querySelector<HTMLElement>(`[data-theme-panel="${id}"]`);
          if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
      } else if (event.data.type === 'wanderline:inspect-ready') {
        const iframe = iframeRef.current;
        iframe?.contentWindow?.postMessage(
          { type: 'wanderline:theme-update', theme },
          window.location.origin,
        );
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateGlobalVariable(key: keyof ThemeVariables, value: string) {
    setTheme((prev) => ({ ...prev, variables: { ...(prev.variables ?? {}), [key]: value } }));
  }

  function updateComponentProp(id: ComponentId, prop: string, value: string) {
    setTheme((prev) => {
      const components = { ...(prev.components ?? {}) };
      const existing = { ...((components[id] ?? {}) as Record<string, string | undefined>) };
      if (value.trim()) existing[prop] = value;
      else delete existing[prop];
      if (Object.keys(existing).length === 0) delete components[id];
      else components[id] = existing;
      return { ...prev, components };
    });
  }

  function toggleWeight(weights: string[] | undefined, weight: string): string[] {
    const set = new Set(weights ?? []);
    if (set.has(weight)) set.delete(weight);
    else set.add(weight);
    return [...set].sort();
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const { settings } = await updateProjectSettings(projectId, { theme });
      setTheme(settings.theme ?? {});
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save theme');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!confirm('Reset the entire theme to defaults?')) return;
    setSaving(true);
    setError(null);
    try {
      const { settings } = await updateProjectSettings(projectId, { theme: {} });
      setTheme(settings.theme ?? {});
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset theme');
    } finally {
      setSaving(false);
    }
  }

  function togglePanel(id: ComponentId) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const iframeSrc = useMemo(() => `/api/projects/${projectId}/preview?inspect=1`, [projectId]);

  if (loading) return <div className="page-loader">Loading theme...</div>;

  const vars = theme.variables ?? {};
  const components = theme.components ?? {};

  // Use a CSS class instead of an inline grid-template-columns so we
  // can collapse to a single column on narrow viewports. The class is
  // defined in index.css under `.theme-layout` with a media query.
  const inspectorStyle: CSSProperties = {
    position: 'sticky',
    top: 16,
    border: '1px solid var(--color-border, rgba(0,0,0,0.1))',
    borderRadius: 8,
    overflow: 'hidden',
    background: '#1a1a2e',
    aspectRatio: '9 / 16',
    maxHeight: 'calc(100vh - 64px)',
  };

  return (
    <div className="tab-panel">
      {error && <div className="alert alert-error">{error}</div>}

      <div className="theme-layout">
        <div>
          <section className="settings-section">
            <h3>Colors (global)</h3>
            <p className="text-muted">
              Affect every component unless overridden in the per-component panels below.
            </p>
            <ul className="ui-options-list" data-testid="theme-colors">
              {VARIABLE_KNOBS.map((knob) => {
                const value = vars[knob.key] ?? '';
                return (
                  <li className="ui-option" key={knob.key}>
                    <label className="bluetooth-option">
                      <span>
                        <strong>{knob.label}</strong>
                        <p className="text-sm text-muted">{knob.hint}</p>
                      </span>
                      <span style={{ display: 'flex', gap: 8 }}>
                        <input
                          type="color"
                          value={isHexish(value) ? value : knob.defaultValue}
                          onChange={(e) => updateGlobalVariable(knob.key, e.target.value)}
                          aria-label={`${knob.label} color picker`}
                        />
                        <input
                          type="text"
                          value={value}
                          onChange={(e) => updateGlobalVariable(knob.key, e.target.value)}
                          placeholder={knob.defaultValue}
                          style={{ width: 110, fontFamily: 'monospace', fontSize: 12 }}
                          aria-label={`${knob.label} value`}
                        />
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="settings-section">
            <h3>Fonts</h3>
            <p className="text-muted">
              Pick any Google Fonts family. Preview pulls from Google&apos;s CDN; builds bundle the
              woff2 files locally.
            </p>
            <ul className="ui-options-list" data-testid="theme-fonts">
              <li className="ui-option">
                <label className="bluetooth-option">
                  <span>
                    <strong>Body font</strong>
                  </span>
                  <FontPicker
                    value={theme.bodyFont ?? ''}
                    onChange={(v) => setTheme((p) => ({ ...p, bodyFont: v }))}
                    placeholder="Inter"
                    ariaLabel="Body font family"
                    testId="theme-body-font"
                  />
                </label>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, marginLeft: 'auto' }}>
                  {COMMON_WEIGHTS.map((w) => (
                    <label
                      key={w}
                      className="text-sm"
                      style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                    >
                      <input
                        type="checkbox"
                        checked={(theme.bodyFontWeights ?? []).includes(w)}
                        onChange={() =>
                          setTheme((p) => ({
                            ...p,
                            bodyFontWeights: toggleWeight(p.bodyFontWeights, w),
                          }))
                        }
                      />
                      {w}
                    </label>
                  ))}
                </div>
              </li>
              <li className="ui-option">
                <label className="bluetooth-option">
                  <span>
                    <strong>Heading font</strong>
                  </span>
                  <FontPicker
                    value={theme.headingFont ?? ''}
                    onChange={(v) => setTheme((p) => ({ ...p, headingFont: v }))}
                    placeholder="Playfair Display"
                    ariaLabel="Heading font family"
                    testId="theme-heading-font"
                  />
                </label>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, marginLeft: 'auto' }}>
                  {COMMON_WEIGHTS.map((w) => (
                    <label
                      key={w}
                      className="text-sm"
                      style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                    >
                      <input
                        type="checkbox"
                        checked={(theme.headingFontWeights ?? []).includes(w)}
                        onChange={() =>
                          setTheme((p) => ({
                            ...p,
                            headingFontWeights: toggleWeight(p.headingFontWeights, w),
                          }))
                        }
                      />
                      {w}
                    </label>
                  ))}
                </div>
              </li>
            </ul>
          </section>

          <section className="settings-section" data-testid="theme-components-section">
            <h3>Components</h3>
            <p className="text-muted">
              Click any component in the live preview to jump to its panel. Edits update the preview
              instantly. Empty fields fall back to the global colors above.
            </p>
            {COMPONENT_SPECS.map((spec) => {
              const isExpanded = expanded.has(spec.id);
              const isActive = activeComponent === spec.id;
              const overrides = (components[spec.id] ?? {}) as Record<string, string | undefined>;
              const overrideCount = Object.values(overrides).filter(
                (v) => typeof v === 'string' && v.trim(),
              ).length;
              return (
                <div
                  key={spec.id}
                  data-theme-panel={spec.id}
                  className="card"
                  style={{
                    padding: 0,
                    marginBottom: 8,
                    border: isActive ? '2px solid var(--color-primary, #4ecdc4)' : undefined,
                    transition: 'border-color 200ms',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => togglePanel(spec.id)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '0.75rem 1rem',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      fontWeight: 600,
                      textAlign: 'left',
                    }}
                    aria-expanded={isExpanded}
                  >
                    <span>
                      <span style={{ marginRight: 8 }}>{isExpanded ? '▼' : '▶'}</span>
                      {spec.label}
                      {overrideCount > 0 && (
                        <span className="badge badge-green" style={{ marginLeft: 8, fontSize: 11 }}>
                          {overrideCount} override{overrideCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  </button>
                  {isExpanded && (
                    <div style={{ padding: '0 1rem 0.75rem' }}>
                      <p className="text-sm text-muted" style={{ marginTop: 0 }}>
                        {spec.hint}
                      </p>
                      <ul className="ui-options-list">
                        {spec.props.map((propSpec) => (
                          <li className="ui-option" key={propSpec.key}>
                            <ComponentPropEditor
                              spec={spec}
                              propSpec={propSpec}
                              value={overrides[propSpec.key]}
                              onChange={(v) => updateComponentProp(spec.id, propSpec.key, v)}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          <section className="settings-section">
            <h3>Custom CSS</h3>
            <p className="text-muted">
              Anything here is appended to the player&apos;s <code>&lt;style&gt;</code> block after
              the variables, so your selectors win. Use sparingly — the per-component panels above
              cover the common cases.
            </p>
            <textarea
              value={theme.customCss ?? ''}
              onChange={(e) => setTheme((p) => ({ ...p, customCss: e.target.value }))}
              placeholder={'.story-card { box-shadow: 0 6px 18px rgba(0,0,0,0.35); }'}
              rows={8}
              spellCheck={false}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
              aria-label="Custom CSS"
              data-testid="theme-custom-css"
            />
          </section>

          <div className="settings-row" style={{ alignItems: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
              data-testid="theme-save"
            >
              {saving ? 'Saving...' : 'Save theme'}
            </button>
            <button className="btn btn-ghost" onClick={handleReset} disabled={saving}>
              Reset to defaults
            </button>
            {savedAt && <span className="text-muted text-sm">Saved at {savedAt}</span>}
          </div>
        </div>

        <div style={inspectorStyle} data-testid="theme-inspector">
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            title="Theme inspector preview"
            style={{ width: '100%', height: '100%', border: 'none' }}
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      </div>
    </div>
  );
}
