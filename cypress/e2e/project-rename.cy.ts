// rename a project from the editor toolbar.

describe('Project rename', () => {
  before(() => {
    cy.setupAdmin();
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('clicking the title flips to an input, Enter commits and persists with a single PATCH', () => {
    cy.apiCreateProject('Rename Source Name').then((projectId) => {
      // Lock in the no-duplicate-request contract — earlier the
      // disabled-input blur fired commit() twice per save.
      cy.intercept('PATCH', `/api/projects/${projectId}`).as('patch');

      cy.visit(`/projects/${projectId}`);
      cy.contains('Rename Source Name', { timeout: 15000 }).should('be.visible');

      cy.get('[data-testid="project-title"]').click();
      cy.get('[data-testid="project-title-input"]', { timeout: 5000 })
        .should('be.focused')
        .clear()
        .type('Renamed Target Name{enter}');

      cy.wait('@patch');
      cy.get('[data-testid="project-title"]', { timeout: 5000 })
        .should('contain.text', 'Renamed Target Name')
        .and('not.contain.text', 'Rename Source Name');

      // Exactly one PATCH; the blur-fires-commit-too bug would
      // make this 2.
      cy.get('@patch.all').should('have.length', 1);

      cy.request('GET', `/api/projects/${projectId}`)
        .its('body.project.name')
        .should('eq', 'Renamed Target Name');
    });
  });

  it('Escape cancels without persisting', () => {
    cy.apiCreateProject('Escape Source Name').then((projectId) => {
      cy.visit(`/projects/${projectId}`);
      cy.contains('Escape Source Name', { timeout: 15000 }).should('be.visible');

      cy.get('[data-testid="project-title"]').click();
      cy.get('[data-testid="project-title-input"]').clear().type('Should Not Save{esc}');

      cy.get('[data-testid="project-title"]').should('contain.text', 'Escape Source Name');

      cy.request('GET', `/api/projects/${projectId}`)
        .its('body.project.name')
        .should('eq', 'Escape Source Name');
    });
  });

  it('a name with $ characters round-trips correctly (regex back-reference safety)', () => {
    // Regression for the build-service title-replace bug ($&, $$, $1 in
    // String.replace) — also covers the rename input not interpreting
    // them. The rename API path doesn't use .replace so this should
    // pass, but lock it in.
    cy.apiCreateProject('Plain Source').then((projectId) => {
      cy.visit(`/projects/${projectId}`);
      cy.contains('Plain Source', { timeout: 15000 }).should('be.visible');
      cy.get('[data-testid="project-title"]').click();
      cy.get('[data-testid="project-title-input"]').clear().type('Cost $50 & rising{enter}');
      cy.get('[data-testid="project-title"]', { timeout: 5000 }).should(
        'contain.text',
        'Cost $50 & rising',
      );
      cy.request('GET', `/api/projects/${projectId}`)
        .its('body.project.name')
        .should('eq', 'Cost $50 & rising');
    });
  });
});
