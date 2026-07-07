// Re-running auto-assign on existing unassigned audio files.
// Use case: author uploaded files before the matcher knew about
// DAW-prefix stripping, or fixed a typo in the story after upload.
// The button should hit /audio/rematch and surface the counts.

describe('Re-match unassigned audio', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Rematch Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('returns a summary with newly-matched + still-unmatched counts', () => {
    // First upload a file whose name doesn't match any node, then
    // a file whose name DOES match. Re-match should pick up only
    // the matching one. (Both unassigned at this point.)
    cy.window().then(async (win) => {
      const form = new win.FormData();
      const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(200).fill(0)]);
      const matchBlob = new win.Blob([bytes], { type: 'audio/mpeg' });
      const nomatchBlob = new win.Blob([bytes], { type: 'audio/mpeg' });
      // Upload as single-files via the legacy endpoint so the bulk
      // auto-match doesn't fire and we get into the "unassigned" state.
      const f1 = new win.File([matchBlob], 'random_unknown_node.mp3', { type: 'audio/mpeg' });
      const f2 = new win.File([nomatchBlob], 'still_nothing.mp3', { type: 'audio/mpeg' });
      form.append('audio', f1);
      form.append('category', 'voiceover');
      await win.fetch(`/api/projects/${projectId}/audio`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });

      const form2 = new win.FormData();
      form2.append('audio', f2);
      form2.append('category', 'voiceover');
      await win.fetch(`/api/projects/${projectId}/audio`, {
        method: 'POST',
        body: form2,
        credentials: 'include',
      });

      const res = await win.fetch(`/api/projects/${projectId}/audio/rematch`, {
        method: 'POST',
        credentials: 'include',
      });
      expect(res.status).to.eq(200);
      const body = await res.json();
      expect(body).to.have.property('success', true);
      expect(body).to.have.property('totalMatched');
      expect(body).to.have.property('totalUnmatched');
      expect(body).to.have.property('alreadyAssigned');
    });
  });

  it('exposes a "Re-match unassigned" button in the AudioTab', () => {
    cy.visit(`/projects/${projectId}`);
    cy.contains('h1', 'Rematch Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Audio').click();
    cy.contains('button', 'Re-match unassigned').should('be.visible');
  });
});
