import { useEffect, useState, type FormEvent } from 'react';
import {
  fetchCharacters,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  type Character,
} from '../api/client';

const THEME_OPTIONS = [
  { value: 'red', label: 'Red', color: '#dc2626' },
  { value: 'orange', label: 'Orange', color: '#ea580c' },
  { value: 'yellow', label: 'Yellow', color: '#ca8a04' },
  { value: 'green', label: 'Green', color: '#16a34a' },
  { value: 'blue', label: 'Blue', color: '#3b82f6' },
  { value: 'indigo', label: 'Indigo', color: '#6366f1' },
  { value: 'purple', label: 'Purple', color: '#9333ea' },
  { value: 'pink', label: 'Pink', color: '#ec4899' },
];

interface Props {
  projectId: string;
}

export default function CharactersTab({ projectId }: Props) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTheme, setNewTheme] = useState('purple');
  const [creating, setCreating] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editTheme, setEditTheme] = useState('');

  useEffect(() => {
    loadCharacters();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadCharacters() {
    try {
      const { characters: data } = await fetchCharacters(projectId);
      setCharacters(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load characters');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);

    const themeObj = THEME_OPTIONS.find((t) => t.value === newTheme);
    try {
      await createCharacter(projectId, newName, themeObj?.color, newTheme);
      setNewName('');
      setNewTheme('purple');
      setShowForm(false);
      await loadCharacters();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create character');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(char: Character) {
    setEditingId(char.id);
    setEditName(char.name);
    setEditTheme(char.theme);
  }

  async function handleUpdate(charId: string) {
    if (!editName.trim()) return;
    setError(null);
    const themeObj = THEME_OPTIONS.find((t) => t.value === editTheme);
    try {
      await updateCharacter(projectId, charId, {
        name: editName.trim(),
        theme: editTheme,
        color: themeObj?.color,
      });
      setEditingId(null);
      await loadCharacters();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update character');
    }
  }

  async function handleDelete(charId: string) {
    if (!confirm('Delete this character? Audio assignments will be unlinked.')) return;
    try {
      await deleteCharacter(projectId, charId);
      setCharacters((prev) => prev.filter((c) => c.id !== charId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  if (loading) return <div className="page-loader">Loading characters...</div>;

  return (
    <div className="tab-panel">
      <div className="section-header">
        <h2>Characters</h2>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New character'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {showForm && (
        <form onSubmit={handleCreate} className="card create-form">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              autoFocus
              placeholder="Character name"
            />
          </label>
          <label className="field">
            <span className="field-label">Theme color</span>
            <div className="theme-picker">
              {THEME_OPTIONS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`theme-swatch ${newTheme === t.value ? 'theme-swatch-active' : ''}`}
                  style={{ backgroundColor: t.color }}
                  onClick={() => setNewTheme(t.value)}
                  title={t.label}
                  aria-label={t.label}
                  aria-pressed={newTheme === t.value}
                />
              ))}
            </div>
          </label>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Creating...' : 'Create character'}
          </button>
        </form>
      )}

      {characters.length === 0 ? (
        <div className="empty-state">
          <p>No characters yet.</p>
          <p className="text-muted">Characters can be assigned to audio files and story nodes.</p>
        </div>
      ) : (
        <div className="character-list">
          {characters.map((char) => (
            <div key={char.id} className="card character-card">
              {editingId === char.id ? (
                <div className="character-edit">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="character-edit-name"
                  />
                  <div className="theme-picker theme-picker-sm">
                    {THEME_OPTIONS.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        className={`theme-swatch theme-swatch-sm ${editTheme === t.value ? 'theme-swatch-active' : ''}`}
                        style={{ backgroundColor: t.color }}
                        onClick={() => setEditTheme(t.value)}
                        title={t.label}
                        aria-label={t.label}
                        aria-pressed={editTheme === t.value}
                      />
                    ))}
                  </div>
                  <div className="character-edit-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleUpdate(char.id)}
                    >
                      Save
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="character-row">
                  <span className="character-dot" style={{ backgroundColor: char.color }} />
                  <span className="character-name">{char.name}</span>
                  <span className="text-muted">
                    {char.audio_count} audio file{char.audio_count !== '1' ? 's' : ''}
                  </span>
                  <div className="character-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => startEdit(char)}>
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost btn-sm btn-danger"
                      onClick={() => handleDelete(char.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
