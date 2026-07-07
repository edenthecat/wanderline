// Covers the editor's Preview tab which embeds the player-app
// via an iframe. The actual playback flow lives in player-app's own
// vitest suite — here we just verify the editor shell mounts the
// iframe, renders the Restart / Open-in-new-tab controls, and shows
// the keyboard hint row.

describe('Story Preview tab', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Preview Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit(`/projects/${projectId}`);
    cy.contains('h1', 'Preview Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Preview').click();
  });

  it('shows the Preview header with Restart and Open-in-new-tab controls', () => {
    cy.contains('h2', 'Preview').should('be.visible');
    cy.contains('button', 'Restart').should('be.visible');
    cy.contains('a', 'Open in new tab').should('have.attr', 'target', '_blank');
  });

  it('renders the keyboard-shortcut hint row', () => {
    cy.contains('Keyboard:').should('be.visible');
    cy.contains('kbd', 'Space').should('be.visible');
    cy.contains('kbd', /^R$/).should('be.visible');
    cy.contains('kbd', /^Esc$/).should('be.visible');
  });

  it('mounts a sandboxed iframe pointing at /api/projects/:id/preview', () => {
    cy.get('iframe.preview-frame')
      .should('have.attr', 'src')
      .and('include', `/api/projects/${projectId}/preview`);
    cy.get('iframe.preview-frame').should('have.attr', 'sandbox');
  });

  it('Restart remounts the iframe (changes its element identity)', () => {
    cy.get('iframe.preview-frame').then(($el) => {
      const initial = $el[0];
      cy.contains('button', 'Restart').click();
      cy.get('iframe.preview-frame').should(($next) => {
        expect($next[0]).to.not.equal(initial);
      });
    });
  });

  it('shows an empty state when the project has no story', () => {
    cy.apiCreateProject('Preview Empty').then((id) => {
      cy.visit(`/projects/${id}`);
      cy.contains('button', 'Preview').click();
      cy.contains('Upload a story file before previewing').should('be.visible');
      cy.get('iframe.preview-frame').should('not.exist');
    });
  });
});
