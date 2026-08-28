import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExportSettings from '../ExportSettings';
import type { ProjectSettings } from '../../api/client';

// The editor half of the per-project language.
//
// Every generated build used to ship `lang="en"` regardless of what
// the story was written in, so a screen reader read a French or
// Spanish caption with an English voice and English phonetics. The
// backend now threads settings.language into <html lang>, smoke.html
// and the manifest; without a control here that setting would be
// unreachable outside a direct database edit.

vi.mock('../../api/client', () => ({
  uploadProjectIcon: vi.fn(),
}));

afterEach(cleanup);

function mount(settings: ProjectSettings = {}) {
  const onSave = vi.fn().mockResolvedValue(settings);
  render(
    <ExportSettings
      projectId="p1"
      settings={settings}
      onSave={onSave as unknown as (patch: Partial<ProjectSettings>) => Promise<ProjectSettings>}
    />,
  );
  return { onSave };
}

describe('ExportSettings — language', () => {
  it('offers a language control', () => {
    mount();
    expect(screen.getByLabelText(/language code/i)).toBeTruthy();
  });

  it('shows the saved language', () => {
    mount({ language: 'pt-BR' });
    expect((screen.getByLabelText(/language code/i) as HTMLInputElement).value).toBe('pt-BR');
  });

  it('saves a valid tag on blur', async () => {
    const { onSave } = mount();
    const input = screen.getByLabelText(/language code/i);
    fireEvent.change(input, { target: { value: 'fr' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ language: 'fr' }));
  });

  it('trims whitespace before saving', async () => {
    const { onSave } = mount();
    const input = screen.getByLabelText(/language code/i);
    fireEvent.change(input, { target: { value: '  pt-BR  ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ language: 'pt-BR' }));
  });

  // The backend would silently normalize a bad tag back to 'en'.
  // Saying so here is the difference between "my setting didn't work"
  // and a typo the author can fix.
  it('rejects a malformed tag instead of saving it', async () => {
    const { onSave } = mount();
    const input = screen.getByLabelText(/language code/i);
    fireEvent.change(input, { target: { value: 'not a tag' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(onSave).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  // Clearing the field is how an author goes back to the default.
  it('saves an empty value to clear the setting', async () => {
    const { onSave } = mount({ language: 'fr' });
    const input = screen.getByLabelText(/language code/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ language: '' }));
  });

  it('does not re-save an unchanged value', () => {
    const { onSave } = mount({ language: 'fr' });
    fireEvent.blur(screen.getByLabelText(/language code/i));
    expect(onSave).not.toHaveBeenCalled();
  });

  // Without this the rejection lands in a discarded promise: no
  // "Saved", no error, and the field still shows the tag — so the
  // author walks away believing it took and ships an English build.
  it('surfaces a failed save instead of swallowing it', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Network is down'));
    render(
      <ExportSettings
        projectId="p1"
        settings={{}}
        onSave={onSave as unknown as (patch: Partial<ProjectSettings>) => Promise<ProjectSettings>}
      />,
    );
    const input = screen.getByLabelText(/language code/i);
    fireEvent.change(input, { target: { value: 'fr' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Network is down'));
  });
});
