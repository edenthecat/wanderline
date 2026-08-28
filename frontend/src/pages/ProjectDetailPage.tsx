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

/** Panel every nav button points at via aria-controls, and the element
 * pickTab moves focus to. */
const WORKSPACE_PANEL_ID = 'workspace-panel';

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
  // Focus plumbing for the mobile sheet: focus moves to the first tool
  // when it opens (the sheet renders after the bottom bar in the DOM,
  // so Tab alone would walk the other three group buttons first) and
  // back to the group button when Escape closes it.
  const firstSheetLinkRef = useRef<HTMLButtonElement>(null);
  const mobileTabRefs = useRef<Partial<Record<GroupId, HTMLButtonElement | null>>>({});
  // Focused by pickTab so a screen reader / keyboard user follows the
  // content swap instead of being left on a button in the nav.
  const panelRef = useRef<HTMLDivElement>(null);
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
    const openGroup = mobileSheet;
    // Focus lives inside the sheet from the moment it opens, so every
    // dismissal path has to hand it back — otherwise the sheet
    // unmounts under the focused button and the user is dropped at
    // the top of the document.
    function close() {
      setMobileSheet(null);
      mobileTabRefs.current[openGroup]?.focus();
    }
    function handleClick(e: MouseEvent) {
      if (!(e.target instanceof Node) || !mobileSheetRef.current) return;
      if (mobileSheetRef.current.contains(e.target)) return;
      // The group buttons own the toggle. Closing here would flush
      // before the click lands, so the button would read the sheet as
      // already shut and immediately reopen it.
      if (e.target instanceof Element && e.target.closest('.workspace-mobile-nav')) return;
      // mousedown's default action moves focus to the hit target's
      // nearest focusable ancestor. The scrim has none, so the
      // browser would put focus on <body> a beat after close()
      // restored it. Scoped to the scrim itself: the scrim is
      // display:none above 767px while this state survives a resize,
      // and blanket-preventing mousedown there would stop clicks from
      // focusing inputs behind it.
      if (e.target instanceof Element && e.target.closest('.workspace-mobile-sheet-backdrop')) {
        e.preventDefault();
      }
      close();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileSheet]);

  // Move focus into the sheet when it opens. The sheet is rendered
  // after the bottom bar, so Tab from the group button would otherwise
  // walk the remaining group buttons before reaching its own contents.
  useEffect(() => {
    if (!mobileSheet) return;
    firstSheetLinkRef.current?.focus();
  }, [mobileSheet]);

  // Deferred to an effect rather than focusing inline in pickTab: the
  // panel's aria-label is derived from activeTab, and focusing before
  // React re-renders would announce the tab you just left.
  const focusPanelRef = useRef(false);
  useEffect(() => {
    if (!focusPanelRef.current) return;
    focusPanelRef.current = false;
    panelRef.current?.focus();
  }, [activeTab]);

  // Name the document after the view. Screen-reader users check the
  // title to orient after a navigation; without this every tab of
  // every project reads as the same page.
  // Captured during render, before any effect has touched it, so the
  // restore below puts back the app's own title and not the previous
  // tab's.
  const baseTitleRef = useRef(typeof document === 'undefined' ? '' : document.title);
  useEffect(() => {
    if (!project) return;
    document.title = `${TAB_LABEL[activeTab]} · ${project.name} · Wanderline`;
  }, [activeTab, project]);
  useEffect(() => {
    const base = baseTitleRef.current;
    // Otherwise the tab still reads "Story · Nightjar" after
    // navigating back to the project list — a title that lies is
    // worse than the generic one it replaced.
    return () => {
      document.title = base;
    };
  }, []);

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
      // Closing unmounts the item that was just activated — hand
      // focus back to the trigger, as the Escape path does, instead
      // of dropping it on <body>.
      exportBtnRef.current?.focus();
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

  /** Keep Tab inside the open sheet. It's the last thing in the DOM,
   * so tabbing past its final button would otherwise wrap to the top
   * of the page — into content the scrim has made unclickable but
   * that is still focusable and still activates on Enter. */
  function trapSheetTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const items = Array.from(
      mobileSheetRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
    );
    if (items.length === 0) return;
    const edge = e.shiftKey ? items[0] : items[items.length - 1];
    if (document.activeElement !== edge) return;
    e.preventDefault();
    (e.shiftKey ? items[items.length - 1] : items[0]).focus();
  }

  function pickTab(t: Tab) {
    // Re-picking the active tab still has to move focus — on mobile
    // it's the gesture that dismisses the sheet.
    if (t === activeTab) {
      panelRef.current?.focus();
    } else {
      focusPanelRef.current = true;
    }
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
                        aria-controls={WORKSPACE_PANEL_ID}
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
              {/* The one element that names the current view. Made a
                  live region so switching tabs is announced — the
                  whole <main> swaps and nothing else says so. It is
                  display:none below 600px, which is one reason pickTab
                  also moves focus into the panel. */}
              <span className="workspace-toolbar-current text-muted" role="status">
                {TAB_LABEL[activeTab]}
              </span>
            </div>
            <div className="workspace-toolbar-actions">
              <PresenceChips users={presentUsers} />
              <div className="dropdown" ref={exportRef}>
                <button
                  ref={exportBtnRef}
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowExportMenu((v) => !v)}
                  aria-expanded={showExportMenu}
                  aria-controls={showExportMenu ? 'export-menu' : undefined}
                >
                  Export
                </button>
                {/* Disclosure, not role="menu". role="menu" carries a
                    keyboard contract (arrow-key roving focus, focus
                    moved in on open, Home/End) that this never
                    implemented, and an unimplemented menu is worse
                    than no menu: the screen reader promises arrow
                    keys that do nothing. These are three plain
                    buttons; aria-expanded on the trigger is the whole
                    of the semantics they need, and Tab already
                    reaches them because they follow the trigger in
                    the DOM. Escape + outside-click close with focus
                    return are handled in an effect above. */}
                {showExportMenu && (
                  <div
                    className="dropdown-menu"
                    id="export-menu"
                    role="group"
                    aria-label="Export options"
                  >
                    <button className="dropdown-item" onClick={() => handleExport('archive')}>
                      Export Archive (.wanderline)
                    </button>
                    <button className="dropdown-item" onClick={() => handleExport('ink')}>
                      Export Ink (.ink)
                    </button>
                    <button className="dropdown-item" onClick={() => handleExport('json')}>
                      Export JSON
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          {/* Yjs collab test surface — only mounted in dev builds
              when ?yjsDemo=1 is set. THIS use-site guard on
              import.meta.env.DEV is what actually drops the
              component (and its transitive imports of the demo
              hook + yjs machinery) from the prod bundle: Vite
              constant-folds the false branch, marks the import
              unused, and tree-shakes it out. The DEV check inside
              the component itself is a belt-and-braces safety net
              for any future caller that forgets this guard.
              Cypress collab specs pass ?yjsDemo=1 to opt in. */}
          {import.meta.env.DEV &&
            typeof window !== 'undefined' &&
            new URLSearchParams(window.location.search).get('yjsDemo') === '1' && (
              <YjsDemoField projectId={id} />
            )}

          {/* Focus target for pickTab: tabbing/announcement otherwise
              never follows the content swap. Labelled so landing here
              says which view you're in. */}
          <div
            className="tab-content"
            id={WORKSPACE_PANEL_ID}
            ref={panelRef}
            tabIndex={-1}
            role="region"
            aria-label={`${TAB_LABEL[activeTab]} panel`}
          >
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
              ref={(el) => {
                mobileTabRefs.current[g.id] = el;
              }}
              className={`workspace-mobile-tab${isActive ? ' workspace-mobile-tab-active' : ''}`}
              // No aria-haspopup="menu": what opens is a modal sheet
              // of plain buttons, not an ARIA menu. See the sheet.
              aria-expanded={isOpen}
              aria-controls={isOpen ? `mobile-sheet-${g.id}` : undefined}
              onClick={() => setMobileSheet(isOpen ? null : g.id)}
            >
              {g.mobileLabel}
            </button>
          );
        })}
      </nav>

      {/* NO aria-hidden on the backdrop. It used to carry
          aria-hidden="true", which every descendant inherits — the
          sheet, its heading and all of its buttons were removed from
          the accessibility tree while staying in the tab order (axe
          `aria-hidden-focus`). Below 767px the desktop sidebar is
          display:none, so this sheet is the only way to change tab:
          hiding it made the editor unnavigable by screen reader.
          If the rest of the page ever needs hiding while this is
          open, that belongs on the sheet's SIBLINGS, never on an
          ancestor of the sheet itself. */}
      {mobileSheet && (
        <div className="workspace-mobile-sheet-backdrop">
          {/* role="dialog" + aria-modal, because the backdrop is an
              opaque fixed scrim over the whole viewport: everything
              behind it is dimmed and unclickable. aria-modal is how
              you hide that content from assistive tech — correctly,
              from the outside — and onKeyDown keeps Tab inside for
              sighted keyboard users, who could otherwise wrap around
              to buttons they can see but not click. */}
          <div
            ref={mobileSheetRef}
            className="workspace-mobile-sheet"
            id={`mobile-sheet-${mobileSheet}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`mobile-sheet-title-${mobileSheet}`}
            onKeyDown={trapSheetTab}
          >
            <h2 className="workspace-mobile-sheet-title" id={`mobile-sheet-title-${mobileSheet}`}>
              {GROUPS.find((g) => g.id === mobileSheet)?.label}
            </h2>
            <ul className="workspace-mobile-sheet-list">
              {GROUPS.find((g) => g.id === mobileSheet)?.tabs.map((t, i) => (
                <li key={t}>
                  <button
                    ref={i === 0 ? firstSheetLinkRef : undefined}
                    className={`workspace-mobile-sheet-link${activeTab === t ? ' workspace-mobile-sheet-link-active' : ''}`}
                    aria-current={activeTab === t ? 'page' : undefined}
                    aria-controls={WORKSPACE_PANEL_ID}
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
