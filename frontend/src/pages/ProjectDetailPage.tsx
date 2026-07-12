import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchProject, type ProjectDetail } from '../api/client';
import StoryTab from '../components/StoryTab';
import AudioTab from '../components/AudioTab';
import MusicTab from '../components/MusicTab';
import CharactersTab from '../components/CharactersTab';
import BuildsTab from '../components/BuildsTab';
import HistoryTab from '../components/HistoryTab';
import EditableProjectTitle from '../components/EditableProjectTitle';
import SettingsTab from '../components/SettingsTab';
import PreviewTab from '../components/PreviewTab';
import GraphTab from '../components/GraphTab';
import ThemeTab from '../components/ThemeTab';
import VolumesTab from '../components/VolumesTab';
import SystemSoundsTab from '../components/SystemSoundsTab';
import HeadphoneControlsTab from '../components/HeadphoneControlsTab';
import PlayerDisplayTab from '../components/PlayerDisplayTab';
import YjsDemoField from '../components/YjsDemoField';
import { PresenceChips } from '../components/PresenceChips';
import { useYjs } from '../hooks/useYjs';
import { useYjsUndo } from '../hooks/useYjsUndo';
import { usePresence } from '../hooks/usePresence';
import { useAuth } from '../contexts/AuthContext';

type Tab =
  | 'story'
  | 'audio'
  | 'music'
  | 'characters'
  | 'volumes'
  | 'systemSounds'
  | 'headphone'
  | 'graph'
  | 'theme'
  | 'playerDisplay'
  | 'preview'
  | 'builds'
  | 'history'
  | 'settings';

// Workspace nav is grouped by workflow stage. A given person tends to
// be doing one of these things at a time (writing, recording, theming,
// shipping) so we cluster the existing tabs into four buckets. On
// desktop the buckets render as a left sidebar; on mobile they become
// a 4-button bottom bar that opens a sheet of the tools inside.
type GroupId = 'narrative' | 'sound' | 'style' | 'ship';
type Group = { id: GroupId; label: string; mobileLabel: string; tabs: Tab[] };
const GROUPS: Group[] = [
  { id: 'narrative', label: 'Narrative', mobileLabel: 'Narrative', tabs: ['story', 'graph'] },
  {
    id: 'sound',
    label: 'Voice & sound',
    mobileLabel: 'Sound',
    tabs: ['audio', 'music', 'characters', 'volumes', 'systemSounds', 'headphone'],
  },
  {
    id: 'style',
    label: 'Look & feel',
    mobileLabel: 'Style',
    tabs: ['theme', 'preview', 'playerDisplay'],
  },
  { id: 'ship', label: 'Ship', mobileLabel: 'Ship', tabs: ['builds', 'history', 'settings'] },
];
const TAB_LABEL: Record<Tab, string> = {
  story: 'Story',
  audio: 'Audio',
  music: 'Music',
  characters: 'Characters',
  volumes: 'Volumes',
  systemSounds: 'System sounds',
  headphone: 'Headphone controls',
  graph: 'Graph',
  theme: 'Theme',
  playerDisplay: 'Player display',
  preview: 'Preview',
  builds: 'Builds',
  history: 'History',
  settings: 'Settings',
};
function groupFor(tab: Tab): GroupId {
  return GROUPS.find((g) => g.tabs.includes(tab))!.id;
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('story');
  const [showExportMenu, setShowExportMenu] = useState(false);
  // Mobile bottom-bar opens a sheet listing the tools in a group.
  // null = no sheet open. Closes on tab pick / outside-click / Escape.
  const [mobileSheet, setMobileSheet] = useState<GroupId | null>(null);
  const mobileSheetRef = useRef<HTMLDivElement>(null);
  // Bumped when a tab nukes project-level data (e.g. SettingsTab's
  // "Delete all audio") so sibling tabs re-mount and refetch instead
  // of showing stale cached lists.
  const [audioDataKey, setAudioDataKey] = useState(0);
  // Bumped after any story-replacing upload (StoryTab's file picker
  // or GraphTab's slide-in editor's Save) so the in-tab + out-of-tab
  // InkSourceEditor instances both treat it as an explicit replace
  // and force-overwrite their local dirty state. Owned at this level
  // so StoryTab and GraphTab share a single key — without this lift,
  // a StoryTab upload wouldn't force-reset GraphTab's editor.
  const [sourceResetKey, setSourceResetKey] = useState(0);
  const bumpSourceResetKey = useCallback(() => setSourceResetKey((n) => n + 1), []);
  const exportRef = useRef<HTMLDivElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);

  // presence. useYjs is single-instance per project,
  // so calling it here piggybacks on the same connection StoryTab
  // opens (the registry refcount means we share one socket).
  const { doc: yDoc, awareness } = useYjs(id ?? '');
  // Yjs UndoManager bound to the nodes map: Ctrl/Cmd-Z reverts the
  // last LOCAL edit (collaborators' changes are untouched). Free
  // because the collab infra is already in place.
  useYjsUndo(yDoc);
  const { user } = useAuth();
  // Author/collab QoL: publish which node THIS user is currently
  // focused on so peers can render a dot on that knot's header.
  // StoryTab updates this via the prop setter; usePresence handles
  // the awareness publish.
  const [selfEditingNodeId, setSelfEditingNodeId] = useState<string | null>(null);
  const presentUsers = usePresence({
    awareness: id ? awareness : null,
    selfUserId: user?.id ?? null,
    selfDisplayName: user?.displayName ?? null,
    selfEditingNodeId,
  });

  useEffect(() => {
    if (!id) return;
    loadProject();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close export menu on outside click or Escape — only when open
  useEffect(() => {
    if (!showExportMenu) return;
    function handleClick(e: MouseEvent) {
      if (e.target instanceof Node && exportRef.current && !exportRef.current.contains(e.target)) {
        setShowExportMenu(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setShowExportMenu(false);
        exportBtnRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showExportMenu]);

  // Close mobile sheet on outside click or Escape.
  useEffect(() => {
    if (!mobileSheet) return;
    function handleClick(e: MouseEvent) {
      if (
        e.target instanceof Node &&
        mobileSheetRef.current &&
        !mobileSheetRef.current.contains(e.target)
      ) {
        setMobileSheet(null);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileSheet(null);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileSheet]);

  /**
   * Fetch the project. Pass `silent` for re-fetches triggered by
   * child saves — the page-level <Loading…> shouldn't flash on
   * every keystroke save because that unmounts the active tab and
   * resets its local state (e.g. StoryTab's expanded-knots set).
   * Only the very first load shows the loader.
   */
  async function loadProject({ silent = false }: { silent?: boolean } = {}) {
    if (!id) return;
    if (!silent) setLoading(true);
    try {
      const { project: data } = await fetchProject(id);
      setProject(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  const handleExport = useCallback(
    (type: 'archive' | 'ink' | 'json') => {
      setShowExportMenu(false);
      const base = `/api/projects/${id}`;
      const urls = {
        archive: `${base}/export`,
        ink: `${base}/export-ink`,
        json: `${base}/export-json`,
      };
      window.open(urls[type], '_blank', 'noopener,noreferrer');
    },
    [id],
  );

  if (loading) return <div className="page-loader">Loading project...</div>;
  if (error)
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
      </div>
    );
  if (!project || !id)
    return (
      <div className="page">
        <div className="alert alert-error">Project not found</div>
      </div>
    );

  const activeGroup = groupFor(activeTab);

  function pickTab(t: Tab) {
    setActiveTab(t);
    setMobileSheet(null);
  }

  return (
    <div className="page project-workspace">
      <div className="workspace-layout">
        <aside className="workspace-sidebar" aria-label="Project sections">
          <nav>
            {GROUPS.map((g) => (
              <section key={g.id} className="workspace-group">
                <h2 className="workspace-group-label">{g.label}</h2>
                <ul className="workspace-group-list">
                  {g.tabs.map((t) => (
                    <li key={t}>
                      <button
                        className={`workspace-link${activeTab === t ? ' workspace-link-active' : ''}`}
                        aria-current={activeTab === t ? 'page' : undefined}
                        onClick={() => pickTab(t)}
                      >
                        {TAB_LABEL[t]}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
        </aside>

        <main className="workspace-main">
          <header className="workspace-toolbar">
            <div className="workspace-toolbar-title">
              <Link to="/" className="workspace-toolbar-back" aria-label="Back to projects">
                ←
              </Link>
              <div className="workspace-toolbar-name">
                <EditableProjectTitle
                  projectId={id}
                  name={project.name}
                  onRenamed={(newName) =>
                    setProject((prev) => (prev ? { ...prev, name: newName } : prev))
                  }
                />
                {project.description && (
                  <p className="workspace-toolbar-desc text-muted">{project.description}</p>
                )}
              </div>
              <span className="workspace-toolbar-current text-muted">{TAB_LABEL[activeTab]}</span>
            </div>
            <div className="workspace-toolbar-actions">
              <PresenceChips users={presentUsers} />
              <div className="dropdown" ref={exportRef}>
                <button
                  ref={exportBtnRef}
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowExportMenu((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={showExportMenu}
                  aria-controls={showExportMenu ? 'export-menu' : undefined}
                >
                  Export
                </button>
                {showExportMenu && (
                  <div className="dropdown-menu" id="export-menu" role="menu">
                    <button
                      className="dropdown-item"
                      role="menuitem"
                      onClick={() => handleExport('archive')}
                    >
                      Export Archive (.wanderline)
                    </button>
                    <button
                      className="dropdown-item"
                      role="menuitem"
                      onClick={() => handleExport('ink')}
                    >
                      Export Ink (.ink)
                    </button>
                    <button
                      className="dropdown-item"
                      role="menuitem"
                      onClick={() => handleExport('json')}
                    >
                      Export JSON
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          {/* Yjs collab test surface — only mounted in dev builds
              when ?yjsDemo=1 is set. Tree-shaken out of the prod
              bundle by the import.meta.env.DEV check on the
              component itself (returns null in prod), and gated at
              the mount site here on the URL param so it doesn't
              render for typical dev sessions either. Cypress
              collab specs pass ?yjsDemo=1 to opt in. */}
          {import.meta.env.DEV &&
            typeof window !== 'undefined' &&
            new URLSearchParams(window.location.search).get('yjsDemo') === '1' && (
              <YjsDemoField projectId={id} />
            )}

          <div className="tab-content">
            {activeTab === 'story' && (
              <StoryTab
                projectId={id}
                storyGraph={project.story_graph}
                inkSource={project.ink_source}
                tweeSource={project.twee_source}
                sourceLanguage={project.source_language}
                nomenclaturePreference={
                  (project.settings?.nomenclature as 'auto' | 'ink' | 'twee' | undefined) ?? 'auto'
                }
                sourceResetKey={sourceResetKey}
                onStoryUpdated={() => loadProject({ silent: true })}
                onSourceReplaced={bumpSourceResetKey}
                otherPresence={presentUsers}
                onSelfEditingNodeChange={setSelfEditingNodeId}
              />
            )}
            {activeTab === 'audio' && (
              <AudioTab key={audioDataKey} projectId={id} storyGraph={project.story_graph} />
            )}
            {activeTab === 'music' && <MusicTab projectId={id} />}
            {activeTab === 'characters' && <CharactersTab projectId={id} />}
            {activeTab === 'volumes' && <VolumesTab projectId={id} />}
            {activeTab === 'systemSounds' && <SystemSoundsTab projectId={id} />}
            {activeTab === 'headphone' && <HeadphoneControlsTab projectId={id} />}
            {activeTab === 'graph' && (
              <GraphTab
                projectId={id}
                storyGraph={project.story_graph}
                inkSource={project.ink_source}
                sourceResetKey={sourceResetKey}
                onStoryUpdated={() => loadProject({ silent: true })}
                onSourceReplaced={bumpSourceResetKey}
              />
            )}
            {activeTab === 'theme' && <ThemeTab projectId={id} />}
            {activeTab === 'playerDisplay' && <PlayerDisplayTab projectId={id} />}
            {activeTab === 'preview' && (
              <PreviewTab projectId={id} hasStory={!!project.story_graph} />
            )}
            {activeTab === 'builds' && (
              <BuildsTab projectId={id} hasStory={!!project.story_graph} />
            )}
            {activeTab === 'history' && (
              <HistoryTab
                projectId={id}
                onRestored={() => {
                  setAudioDataKey((k) => k + 1);
                  loadProject({ silent: true });
                }}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsTab
                projectId={id}
                projectName={project.name}
                onProjectDataInvalidated={() => {
                  setAudioDataKey((k) => k + 1);
                  // SettingsTab also fires this after a
                  // nomenclature-preference save, and StoryTab/GraphTab
                  // read the vocab from project.settings.nomenclature.
                  // Silent-refetch the project so those tabs pick up
                  // the new value on their next render, not after a
                  // full page reload.
                  loadProject({ silent: true });
                }}
              />
            )}
          </div>
        </main>
      </div>

      {/* Mobile bottom navigation: 4 group buttons; tapping opens a
          sheet of the tools inside. Hidden on desktop via CSS. */}
      <nav className="workspace-mobile-nav" aria-label="Project sections (mobile)">
        {GROUPS.map((g) => {
          const isActive = activeGroup === g.id;
          const isOpen = mobileSheet === g.id;
          return (
            <button
              key={g.id}
              className={`workspace-mobile-tab${isActive ? ' workspace-mobile-tab-active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={isOpen ? `mobile-sheet-${g.id}` : undefined}
              onClick={() => setMobileSheet(isOpen ? null : g.id)}
            >
              {g.mobileLabel}
            </button>
          );
        })}
      </nav>

      {mobileSheet && (
        <div className="workspace-mobile-sheet-backdrop" aria-hidden="true">
          <div
            ref={mobileSheetRef}
            className="workspace-mobile-sheet"
            role="menu"
            id={`mobile-sheet-${mobileSheet}`}
            aria-label={GROUPS.find((g) => g.id === mobileSheet)?.label}
          >
            <h2 className="workspace-mobile-sheet-title">
              {GROUPS.find((g) => g.id === mobileSheet)?.label}
            </h2>
            <ul className="workspace-mobile-sheet-list">
              {GROUPS.find((g) => g.id === mobileSheet)?.tabs.map((t) => (
                <li key={t}>
                  <button
                    className={`workspace-mobile-sheet-link${activeTab === t ? ' workspace-mobile-sheet-link-active' : ''}`}
                    role="menuitem"
                    aria-current={activeTab === t ? 'page' : undefined}
                    onClick={() => pickTab(t)}
                  >
                    {TAB_LABEL[t]}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
