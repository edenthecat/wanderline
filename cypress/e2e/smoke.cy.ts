describe('Smoke test', () => {
  it('should load the app successfully', () => {
    cy.visit('/');
    cy.document().its('contentType').should('equal', 'text/html');
    cy.get('body').should('be.visible');
  });

  it('should show the Wanderline heading', () => {
    cy.visit('/');
    cy.contains('Wanderline').should('be.visible');
  });
});
