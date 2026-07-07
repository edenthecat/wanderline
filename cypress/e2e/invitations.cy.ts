// Covers ..96: magic-link invitation flow end-to-end.
// Admin generates a one-time link → recipient visits link → fills the
// acceptance form → ends up logged in as the role the admin chose.

describe('User invitations (magic link)', () => {
  const recipient = {
    email: `invitee-${Date.now()}@example.com`,
    displayName: 'Invited Person',
    password: 'inviteeP@ssw0rd',
  };

  before(() => {
    cy.setupAdmin();
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit('/users');
    cy.contains('h1', 'Users').should('be.visible');
  });

  it('admin can generate a magic link and see it once', () => {
    cy.get('[data-testid="invitations-section"]').within(() => {
      cy.contains('button', 'Invite user').click();
      cy.get('[data-testid="invite-form"]').within(() => {
        cy.get('input[type=email]').type(recipient.email);
        cy.get('select').select('editor');
        cy.contains('button', 'Generate magic link').click();
      });
      cy.get('[data-testid="invite-magic-link"]', { timeout: 10000 }).should('be.visible');
      cy.get('[data-testid="invite-magic-link"]').contains(recipient.email);
      cy.get('[data-testid="invite-magic-link"] input[type=text]')
        .invoke('val')
        .should('match', /\/invite\/[A-Za-z0-9_-]{16,}$/);
    });
    // Row appears in the pending list.
    cy.get('[data-testid="invitation-row"]').contains(recipient.email).should('be.visible');
  });

  it('rejects a second invitation for the same email until revoked', () => {
    cy.get('[data-testid="invitations-section"]').within(() => {
      cy.contains('button', 'Invite user').click();
      cy.get('[data-testid="invite-form"]').within(() => {
        cy.get('input[type=email]').type(recipient.email);
        cy.contains('button', 'Generate magic link').click();
      });
      // Server returns 409 — surfaced via the page-level error alert.
    });
    cy.contains('.alert', /pending invitation/i).should('be.visible');
  });

  it('invited user can accept the link and lands logged in', () => {
    // Pull the magic link via the API directly — the UI only shows it
    // once and we already consumed that path above. Generating a fresh
    // invitation for a NEW email keeps tests independent.
    const freshEmail = `invitee-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    cy.request('POST', '/api/invitations', { email: freshEmail, role: 'editor' }).then((res) => {
      const url: string = res.body.magicLinkUrl;
      // Drop the host so cy.visit stays on the test baseUrl.
      const path = url.replace(/^https?:\/\/[^/]+/, '');

      // Log out the admin first so the accept flow exercises the
      // unauthenticated landing-page path.
      cy.request('POST', '/api/auth/logout');
      cy.visit(path);

      cy.get('[data-testid="invite-accept-form"]').within(() => {
        cy.get('input[type=email]').should('have.value', freshEmail);
        cy.contains('label', 'Display name').find('input').type('Newcomer');
        cy.contains('label', 'Password').find('input').type('newP@ssword');
        cy.contains('label', 'Confirm password').find('input').type('newP@ssword');
        cy.contains('button', 'Create account').click();
      });

      // After accept we're redirected to / and the auth context loads.
      cy.url().should('match', /\/$|\/projects/);
      cy.request('GET', '/api/auth/me').its('body.user.email').should('eq', freshEmail);
    });
  });

  it('revoked invitations 410 when the recipient visits the link', () => {
    const revokedEmail = `revoked-${Date.now()}@example.com`;
    cy.request('POST', '/api/invitations', { email: revokedEmail, role: 'editor' }).then((res) => {
      const invId: string = res.body.invitation.id;
      const url: string = res.body.magicLinkUrl;
      const path = url.replace(/^https?:\/\/[^/]+/, '');

      cy.request('DELETE', `/api/invitations/${invId}`);
      cy.request('POST', '/api/auth/logout');
      cy.visit(path);
      cy.contains('no longer valid').should('be.visible');
    });
  });

  it('passwords must match before the form submits', () => {
    const email = `mismatch-${Date.now()}@example.com`;
    cy.request('POST', '/api/invitations', { email, role: 'editor' }).then((res) => {
      const path = res.body.magicLinkUrl.replace(/^https?:\/\/[^/]+/, '');
      cy.request('POST', '/api/auth/logout');
      cy.visit(path);
      cy.get('[data-testid="invite-accept-form"]').within(() => {
        cy.contains('label', 'Display name').find('input').type('Newcomer');
        cy.contains('label', 'Password').find('input').type('newP@ssword');
        cy.contains('label', 'Confirm password').find('input').type('different!!');
        cy.contains('button', 'Create account').click();
      });
      cy.contains('.alert', /do not match/i).should('be.visible');
    });
  });
});
