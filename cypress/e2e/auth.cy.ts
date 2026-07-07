describe('Authentication', () => {
  before(() => {
    cy.setupAdmin();
  });

  it('should show login page when not authenticated', () => {
    cy.visit('/');
    cy.contains('Sign in to continue').should('be.visible');
    cy.contains('button', 'Sign in').should('be.visible');
  });

  it('should show error for invalid credentials', () => {
    cy.visit('/');
    cy.get('input[type="email"]').type('wrong@test.com');
    cy.get('input[type="password"]').type('wrongpassword');
    cy.contains('button', 'Sign in').click();

    cy.contains(/invalid|error|incorrect/i).should('be.visible');
  });

  it('should login successfully with valid credentials', () => {
    cy.visit('/');
    cy.uiLogin();

    cy.contains('Projects', { timeout: 15000 }).should('be.visible');
  });

  it('should persist session across page reloads', () => {
    cy.apiLogin();
    cy.visit('/');

    cy.contains('Projects', { timeout: 15000 }).should('be.visible');
  });

  it('should logout successfully', () => {
    cy.apiLogin();
    cy.visit('/');
    cy.contains('Projects', { timeout: 15000 }).should('be.visible');

    cy.contains('button', 'Log out').click();

    cy.contains('Sign in to continue').should('be.visible');
  });
});
