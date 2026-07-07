// dedicated music panel for background tracks. Audio is
// stored under category='music' (story-data-builder.ts already
// surfaces those as backgroundMusic in the generated game); this
// tab just makes the upload + management workflow obvious.

describe('Music tab', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Music Tab Test').then((id) => {
      projectId = id;
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('exposes a Music tab under the Sound group', () => {
    cy.visit(`/projects/${projectId}`);
    cy.contains('Music Tab Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Music').click();
    cy.get('[data-testid="music-tab"]', { timeout: 5000 }).should('be.visible');
    cy.contains('Background music').should('be.visible');
    cy.contains('No background music yet').should('be.visible');
  });

  it('upload + delete round-trip', () => {
    cy.visit(`/projects/${projectId}`);
    cy.contains('button', 'Music').click();
    cy.get('[data-testid="music-tab"]', { timeout: 5000 }).should('be.visible');

    // Build a tiny mp3-shaped blob — backend accepts based on MIME
    // type, not content, so any audio/* mime works for the test.
    cy.get('[data-testid="music-upload-input"]').selectFile(
      {
        contents: Cypress.Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]),
        fileName: 'theme.mp3',
        mimeType: 'audio/mpeg',
      },
      { force: true },
    );

    cy.get('[data-testid="music-row"]', { timeout: 10000 }).should('have.length', 1);
    cy.contains('[data-testid="music-row"]', 'theme.mp3').should('be.visible');

    cy.on('window:confirm', () => true);
    cy.get('[data-testid="music-delete-btn"]').click();
    cy.contains('No background music yet', { timeout: 5000 }).should('be.visible');
  });
});
