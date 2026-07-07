import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { fetchProjects, createProject, type ProjectSummary } from '../api/client';

export default function ProjectListPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New project form
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    try {
      const { projects: data } = await fetchProjects();
      setProjects(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);

    try {
      await createProject(newName, newDesc || undefined);
      setNewName('');
      setNewDesc('');
      setShowForm(false);
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="page-loader">Loading projects...</div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Projects</h1>
        <button
          className="btn btn-primary"
          onClick={() => setShowForm((v) => !v)}
          aria-expanded={showForm}
          aria-controls="new-project-form"
        >
          {showForm ? 'Cancel' : 'New project'}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {showForm && (
        <form
          id="new-project-form"
          onSubmit={handleCreate}
          className="card create-form"
          aria-label="New project"
        >
          <label className="field">
            <span className="field-label">Project name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              autoFocus
              placeholder="My Story Project"
            />
          </label>
          <label className="field">
            <span className="field-label">Description (optional)</span>
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="A brief description"
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating}
            aria-busy={creating}
          >
            {creating ? 'Creating...' : 'Create project'}
          </button>
        </form>
      )}

      {projects.length === 0 ? (
        <div className="empty-state">
          <p>No projects yet. Create one to get started.</p>
        </div>
      ) : (
        <ul className="project-grid" aria-label="Your projects">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="project-card card">
                <h3 className="project-card-name">{p.name}</h3>
                {p.description && <p className="project-card-desc">{p.description}</p>}
                <div className="project-card-meta">
                  {p.has_story && (
                    <span className="badge badge-green">{p.story_title || 'Story uploaded'}</span>
                  )}
                  {!p.has_story && <span className="badge badge-gray">No story</span>}
                  {/*: source-language badge so users can tell
                      Ink vs Twee projects apart at a glance. Only
                      render when the project has a story — an empty
                      project's source_language is the default 'ink'
                      and showing it there would be misleading. */}
                  {p.has_story && (
                    <span
                      className={`badge ${p.source_language === 'twee' ? 'badge-purple' : 'badge-blue'}`}
                      aria-label={`Source language: ${p.source_language === 'twee' ? 'Twee 3' : 'Ink'}`}
                    >
                      {p.source_language === 'twee' ? 'Twee' : 'Ink'}
                    </span>
                  )}
                  <span className="text-muted">
                    Updated{' '}
                    <time dateTime={p.updated_at}>
                      {new Date(p.updated_at).toLocaleDateString()}
                    </time>
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
