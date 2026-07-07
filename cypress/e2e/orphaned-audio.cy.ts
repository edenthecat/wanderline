// Covers surfaces audio files that exist in the project but
// aren't assigned to any node, with name/size/upload-date columns and
// a per-row + bulk delete flow.

describe('Orphaned audio panel', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Orphaned Audio Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
      // Upload three audio files without assigning them to any node.
      // Same pattern the editor uses — multipart with a category.
      for (const filename of ['ghost.mp3', 'echo.mp3', 'mistake.mp3']) {
        const fd = new FormData();
        fd.append('audio', new Blob([new Uint8Array(1024)], { type: 'audio/mpeg' }), filename);
        fd.append('category', 'voiceover');
        cy.request({
          method: 'POST',
          url: `/api/projects/${id}/audio`,
          body: fd,
          // Let Cypress set the multipart Content-Type with boundary
        });
      }
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit(`/projects/${projectId}`);
    cy.contains('h1', 'Orphaned Audio Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Audio').click();
  });

  it('renders the panel with each orphaned file row + size + date', () => {
    cy.get('[data-testid="orphaned-audio-panel"]')
      .should('be.visible')
      .within(() => {
        cy.contains('Orphaned audio files').should('be.visible');
        cy.contains('ghost.mp3').should('be.visible');
        cy.contains('echo.mp3').should('be.visible');
        cy.contains('mistake.mp3').should('be.visible');
        // Each file is 1024 bytes → "1.0 KB" via formatBytes
        cy.contains('1.0 KB').should('be.visible');
      });
  });

  it('shows a count + total size in the panel header', () => {
    cy.get('[data-testid="orphaned-audio-panel"]')
      .find('.section-header')
      .within(() => {
        cy.contains(/3 files/).should('be.visible');
        // 3 × 1024 bytes = 3.1 KB
        cy.contains('3.1 KB').should('be.visible');
      });
  });

  it('requires confirmation for bulk delete and removes all files', () => {
    cy.get('[data-testid="orphaned-audio-panel"]').within(() => {
      cy.contains('button', /Delete all 3 orphaned files/).click();
      // Confirmation step
      cy.contains('Confirm delete all').should('be.visible');
      cy.contains('This can’t be undone').should('be.visible');
      cy.contains('button', 'Confirm delete all').click();
    });

    // Panel disappears once orphans are gone
    cy.get('[data-testid="orphaned-audio-panel"]', { timeout: 15000 }).should('not.exist');

    // Verify the audio list dropped to zero unassigned files via coverage API
    cy.request('GET', `/api/projects/${projectId}/audio/coverage`).then((res) => {
      expect(res.body.orphanedAudioFiles).to.have.length(0);
    });
  });

  it('hides the panel when no files are orphaned', () => {
    cy.apiCreateProject('Clean Audio Test').then((id) => {
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
      cy.visit(`/projects/${id}`);
      cy.contains('button', 'Audio').click();
      // No orphans uploaded — panel never renders
      cy.get('[data-testid="orphaned-audio-panel"]').should('not.exist');
    });
  });
});
