// Covers the Story tab's node tree with search + type filter +
// expand-on-click. (The old skipped version asserted a separate
// "List View" button and a different selector set — the refactor
// merged that into the main Story tab.)

describe('Story node list', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Node List Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit(`/projects/${projectId}`);
    cy.contains('h1', 'Node List Test', { timeout: 15000 }).should('be.visible');
  });

  it('renders each knot from the test fixture', () => {
    cy.contains('.node-header', 'her').should('be.visible');
    cy.contains('.node-header', '_intro').should('be.visible');
    cy.contains('.node-header', 'tell_you').should('be.visible');
    cy.contains('.node-header', 'credits').should('be.visible');
    cy.contains('.node-header', 'marked_for_tragedy').should('be.visible');
  });

  it('labels each row with its node type', () => {
    cy.contains('.node-header', '_intro').within(() => {
      cy.contains('.badge', 'knot').should('be.visible');
    });
  });

  it('exposes a search input and a type-filter dropdown', () => {
    cy.get('input[placeholder*="Search nodes"]').should('be.visible');
    cy.get('select')
      .first()
      .within(() => {
        cy.get('option').should('have.length.at.least', 2);
      });
  });

  it('filters nodes by search text', () => {
    cy.get('input[placeholder*="Search nodes"]').type('marked');
    cy.contains('marked_for_tragedy').should('be.visible');
    // Other knots are filtered out of the visible list
    cy.contains('.node-header', '_intro').should('not.exist');
  });

  it('expands a node on click to reveal NodeDetail', () => {
    cy.contains('.node-header', 'her').click();
    cy.contains('Voiceover script override').should('be.visible');
    cy.contains('Timing & auto-advance').should('be.visible');
  });

  it('shows inline choice editors on the expanded node', () => {
    cy.contains('.node-header', 'her').click();
    cy.get('input[aria-label="Choice 1 text"]').should('have.value', 'BEFORE');
    cy.get('input[aria-label="Choice 2 text"]').should('have.value', 'AFTER');
  });
});
