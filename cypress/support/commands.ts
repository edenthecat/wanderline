// Use empty base so all API requests go through Cypress baseUrl (localhost:3000)
// which proxies to the backend — keeps session cookies on the same origin
const API_URL = '';

const TEST_ADMIN = {
  email: 'admin@test.com',
  password: 'testpassword123',
  displayName: 'Test Admin',
};

declare global {
  namespace Cypress {
    interface Chainable {
      /** Create the initial admin account via the setup API */
      setupAdmin(): Chainable<void>;
      /** Login via the API (session cookie is auto-handled by Cypress) */
      apiLogin(email?: string, password?: string): Chainable<void>;
      /** Create a project via the API and return its ID */
      apiCreateProject(name: string, description?: string): Chainable<string>;
      /** Delete a project via the API */
      apiDeleteProject(id: string): Chainable<void>;
      /** Upload an ink file to a project via the API */
      apiUploadInk(projectId: string, inkContent: string): Chainable<void>;
      /** Upload a Twee 3 file to a project via the API */
      apiUploadTwee(projectId: string, tweeContent: string): Chainable<void>;
      /** Login through the UI */
      uiLogin(email?: string, password?: string): Chainable<void>;
    }
  }
}

Cypress.Commands.add('setupAdmin', () => {
  cy.request('GET', `${API_URL}/api/setup/status`).then((res) => {
    if (res.body.needsSetup) {
      cy.request('POST', `${API_URL}/api/setup`, TEST_ADMIN);
    }
  });
});

Cypress.Commands.add('apiLogin', (email = TEST_ADMIN.email, password = TEST_ADMIN.password) => {
  cy.request('POST', `${API_URL}/api/auth/login`, { email, password });
});

Cypress.Commands.add('apiCreateProject', (name: string, description?: string) => {
  cy.request('POST', `${API_URL}/api/projects`, {
    name,
    description,
  }).then((res) => {
    return res.body.project.id;
  });
});

Cypress.Commands.add('apiDeleteProject', (id: string) => {
  cy.request('DELETE', `${API_URL}/api/projects/${id}`);
});

Cypress.Commands.add('apiUploadInk', (projectId: string, inkContent: string) => {
  cy.request('POST', `${API_URL}/api/projects/${projectId}/ink`, {
    source: inkContent,
  });
});

Cypress.Commands.add('apiUploadTwee', (projectId: string, tweeContent: string) => {
  cy.request('POST', `${API_URL}/api/projects/${projectId}/twine`, {
    source: tweeContent,
  });
});

Cypress.Commands.add('uiLogin', (email = TEST_ADMIN.email, password = TEST_ADMIN.password) => {
  cy.get('input[type="email"]').type(email);
  cy.get('input[type="password"]').type(password);
  cy.contains('button', 'Sign in').click();
});

export {};
