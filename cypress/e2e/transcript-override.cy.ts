// Covers per-node voiceover script override editor in the
// Story tab. The textarea, save/clear/discard buttons, and the
// "active" badge that surfaces when an override is stored.

describe('Transcript override editor', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Transcript Override Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit(`/projects/${projectId}`);
    cy.contains('h1', 'Transcript Override Test', { timeout: 15000 }).should('be.visible');
    // Story tab is the default landing tab; expand _intro to surface the editor
    cy.contains('.node-header', '_intro', { timeout: 10000 }).click();
  });

  it('renders the override editor with original Ink text visible above the textarea', () => {
    cy.contains('Voiceover script override').should('be.visible');
    cy.contains("Hi, whoever's reading this").should('be.visible');
    cy.get('textarea.transcript-override-input').should('be.visible').and('not.be.disabled');
    // No override saved yet — no "active" badge
    cy.contains('Voiceover script override')
      .parent()
      .within(() => {
        cy.contains('active').should('not.exist');
      });
  });

  it('saves an override, shows the active badge, and offers a Clear button', () => {
    const overrideText = 'Welcome traveler. Press space to begin.';
    cy.get('textarea.transcript-override-input').clear().type(overrideText);
    cy.contains('button', 'Save override').click();

    // After save, badge appears and Clear is rendered.
    cy.contains('Voiceover script override')
      .parent()
      .within(() => {
        cy.contains('active').should('be.visible');
      });
    cy.contains('button', 'Clear override').should('be.visible');

    // API check
    cy.request('GET', `/api/projects/${projectId}/metadata/_intro`).then((res) => {
      expect(res.body.metadata.transcript).to.eq(overrideText);
    });

    // Save button disabled while not dirty
    cy.contains('button', 'Save override').should('be.disabled');
  });

  it('clears the override, removing the active badge and Clear button', () => {
    // Seed an override via API so the test is independent of the previous one
    cy.request('PUT', `/api/projects/${projectId}/metadata/_intro`, {
      transcript: 'Will be cleared by Cypress.',
    });
    cy.reload();
    cy.contains('.node-header', '_intro').click();
    cy.contains('button', 'Clear override').click();

    cy.contains('Voiceover script override')
      .parent()
      .within(() => {
        cy.contains('active').should('not.exist');
      });
    cy.contains('button', 'Clear override').should('not.exist');

    cy.request('GET', `/api/projects/${projectId}/metadata/_intro`).then((res) => {
      // Cleared override comes back as '' (not the original Ink content).
      expect(res.body.metadata.transcript).to.eq('');
    });
  });

  it('treats whitespace-only input as a clear, not as a stored override', () => {
    cy.get('textarea.transcript-override-input').clear().type('   ');
    cy.contains('button', 'Save override').click();

    cy.request('GET', `/api/projects/${projectId}/metadata/_intro`).then((res) => {
      // Whitespace-only is normalized to '' by handleSave so the player
      // doesn't speak ' ' / '\n'.
      expect(res.body.metadata.transcript).to.eq('');
    });
  });

  it('discards in-progress edits without touching the server', () => {
    // Persist a baseline override
    cy.request('PUT', `/api/projects/${projectId}/metadata/_intro`, {
      transcript: 'Baseline override.',
    });
    cy.reload();
    cy.contains('.node-header', '_intro').click();

    // Type new content
    cy.get('textarea.transcript-override-input').clear().type('Discarded edits');
    cy.contains('button', 'Discard changes').should('be.visible').click();

    cy.get('textarea.transcript-override-input').should('have.value', 'Baseline override.');

    // Server unchanged
    cy.request('GET', `/api/projects/${projectId}/metadata/_intro`).then((res) => {
      expect(res.body.metadata.transcript).to.eq('Baseline override.');
    });
  });
});
