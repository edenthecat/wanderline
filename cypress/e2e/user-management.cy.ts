// Covers the User Management admin page. The skipped legacy
// version asserted slightly different button text and a "Back to
// Projects" link; the current page lives at /users (linked from the
// top header) with "Add user" / "Cancel" / "Create user" verbs.

function navigateToUserManagement() {
  cy.apiLogin();
  cy.visit('/users');
  cy.contains('h1', 'Users', { timeout: 15000 }).should('be.visible');
}

describe('User Management', () => {
  const uniqueId = Date.now();

  before(() => {
    cy.setupAdmin();
  });

  it('lists the admin user with Name / Email / Role columns', () => {
    navigateToUserManagement();

    cy.contains('Test Admin').should('be.visible');
    cy.contains('admin@test.com').should('be.visible');
    cy.contains('th', 'Name').should('be.visible');
    cy.contains('th', 'Email').should('be.visible');
    cy.contains('th', 'Role').should('be.visible');
  });

  it('opens and closes the add-user form', () => {
    navigateToUserManagement();

    cy.contains('button', 'Add user').click();
    cy.contains('button', 'Create user').should('be.visible');
    cy.contains('button', 'Cancel').click();
    cy.contains('button', 'Create user').should('not.exist');
  });

  it('creates a new editor user', () => {
    navigateToUserManagement();
    cy.contains('button', 'Add user').click();

    cy.contains('label', 'Display name').find('input').type(`Editor ${uniqueId}`);
    cy.contains('label', 'Email').find('input').type(`editor-${uniqueId}@test.com`);
    cy.contains('label', 'Password').find('input').type('editorpass123');
    cy.contains('label', 'Role').find('select').select('Editor');

    cy.contains('button', 'Create user').click();
    cy.contains(`Editor ${uniqueId}`).should('be.visible');
    cy.contains(`editor-${uniqueId}@test.com`).should('be.visible');
  });
});

describe('Editor user access', () => {
  const uniqueId = Date.now() + 1; // avoid collision with the previous describe
  const editorEmail = `editor-access-${uniqueId}@test.com`;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();

    cy.request({
      method: 'POST',
      url: '/api/users',
      body: {
        email: editorEmail,
        password: 'editorpass123',
        displayName: `Access Editor ${uniqueId}`,
        role: 'editor',
      },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([201, 409]);
    });

    cy.request('POST', '/api/auth/logout');
  });

  it('lets an editor user log in', () => {
    cy.visit('/login');
    cy.uiLogin(editorEmail, 'editorpass123');
    cy.contains('h1', 'Projects', { timeout: 10000 }).should('be.visible');
  });

  it('does not show the Users link in the header for editors', () => {
    cy.request('POST', '/api/auth/login', {
      email: editorEmail,
      password: 'editorpass123',
    });
    cy.visit('/');
    cy.contains('h1', 'Projects').should('be.visible');
    cy.contains('a', 'Users').should('not.exist');
  });
});
