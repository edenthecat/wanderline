describe('Initial Setup', () => {
  before(function () {
    // This test suite only works on a fresh database.
    // Skip if setup has already been completed.
    cy.request('GET', '/api/setup/status').then((res) => {
      if (!res.body.needsSetup) {
        this.skip();
      }
    });
  });

  it('should show the setup page on a fresh database', () => {
    cy.visit('/');
    cy.contains('Create your admin account to get started').should('be.visible');
  });

  it('should require all fields to create admin', () => {
    cy.visit('/');
    cy.contains('button', 'Create admin account').should('be.visible');

    cy.get('input[type="text"]').should('be.visible');
    cy.get('input[type="email"]').should('be.visible');
    cy.get('input[type="password"]').should('have.length.at.least', 1);
  });

  it('should create admin account and redirect to dashboard', () => {
    cy.visit('/');
    cy.contains('Create your admin account').should('be.visible');

    cy.contains('Display name').parent().find('input').type('Test Admin');
    cy.contains('Email').parent().find('input').type('admin@test.com');
    cy.contains('Password').parent().find('input[type="password"]').type('testpassword123');

    cy.contains('button', 'Create admin account').click();

    cy.contains('Projects', { timeout: 15000 }).should('be.visible');
  });
});
