describe('Auth API', () => {
  before(() => {
    cy.setupAdmin();
  });

  it('should check setup status', () => {
    cy.request('GET', '/api/setup/status').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.needsSetup).to.eq(false);
    });
  });

  it('should reject login with wrong email', () => {
    cy.request({
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'nonexistent@test.com',
        password: 'testpassword123',
      },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(401);
    });
  });

  it('should reject login with wrong password', () => {
    cy.request({
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'admin@test.com',
        password: 'wrongpassword',
      },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(401);
    });
  });

  it('should login successfully', () => {
    cy.request('POST', '/api/auth/login', {
      email: 'admin@test.com',
      password: 'testpassword123',
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.user).to.have.property('email', 'admin@test.com');
      expect(res.body.user).to.have.property('displayName', 'Test Admin');
      expect(res.body.user).to.have.property('role', 'admin');
    });
  });

  it('should return current user info', () => {
    cy.apiLogin();
    cy.request('GET', '/api/auth/me').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.user.email).to.eq('admin@test.com');
      expect(res.body.user.role).to.eq('admin');
    });
  });

  it('should reject unauthenticated requests to protected routes', () => {
    cy.clearCookies();
    cy.request({
      method: 'GET',
      url: '/api/projects',
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(401);
    });
  });

  it('should logout successfully', () => {
    cy.apiLogin();
    cy.request('POST', '/api/auth/logout').then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request({
      method: 'GET',
      url: '/api/auth/me',
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(401);
    });
  });

  it('should prevent setup when admin already exists', () => {
    cy.request({
      method: 'POST',
      url: '/api/setup',
      body: {
        email: 'hacker@test.com',
        password: 'hacked123',
        displayName: 'Hacker',
      },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([400, 403]);
    });
  });
});

describe('User Management API', () => {
  before(() => {
    cy.setupAdmin();
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should list users', () => {
    cy.request('GET', '/api/users').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.users).to.be.an('array');
      expect(res.body.users.length).to.be.greaterThan(0);
    });
  });

  it('should create a new user', () => {
    cy.request({
      method: 'POST',
      url: '/api/users',
      body: {
        email: `newuser-api-${Date.now()}@test.com`,
        password: 'newuserpass123',
        displayName: 'New API User',
        role: 'editor',
      },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([201, 409]);
    });
  });

  it('should reject creating user with duplicate email', () => {
    cy.request({
      method: 'POST',
      url: '/api/users',
      body: {
        email: 'admin@test.com',
        password: 'another123',
        displayName: 'Duplicate',
        role: 'editor',
      },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.be.oneOf([400, 409]);
    });
  });

  it('should reject non-admin access to user management', () => {
    const editorEmail = `noaccess-editor-${Date.now()}@test.com`;

    cy.request({
      method: 'POST',
      url: '/api/users',
      body: {
        email: editorEmail,
        password: 'editorpass123',
        displayName: 'No Access Editor',
        role: 'editor',
      },
      failOnStatusCode: false,
    });

    cy.request('POST', '/api/auth/login', {
      email: editorEmail,
      password: 'editorpass123',
    });

    cy.request({
      method: 'GET',
      url: '/api/users',
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(403);
    });
  });
});
