// presence chips. A second connected editor for
// the same project must show up as a chip in the first tab's
// toolbar. We can't easily open two real browser sessions in one
// Cypress spec, so instead we drive presence via the shared
// awareness object exposed on window — the same registry the page
// uses, so a "remote" awareness update is indistinguishable from a
// real second browser to the rendered chips.

describe('Yjs presence chips', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Presence Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('shows the local user is connected but does not chip themselves', () => {
    cy.visit(`/projects/${projectId}?yjsDemo=1`);
    cy.get('[data-testid="yjs-status"]', { timeout: 10000 }).should('have.text', 'connected');

    // The local user owns one awareness slot but the chips list
    // filters their own clientID out — so with only THIS tab open,
    // the chip strip should be absent.
    cy.get('[data-testid="presence-chips"]').should('not.exist');
  });

  it('renders a chip for a simulated remote editor', () => {
    cy.visit(`/projects/${projectId}?yjsDemo=1`);
    cy.get('[data-testid="yjs-status"]', { timeout: 10000 }).should('have.text', 'connected');

    // Push a fake awareness entry under a clientID that ISN'T ours.
    // Awareness state is keyed by clientID; the local hook reads
    // awareness.getStates() and renders every non-local entry.
    cy.window().then((win) => {
      const debug = (
        win as unknown as {
          __yjsDebug: {
            awareness: {
              clientID: number;
              setLocalStateField: (k: string, v: unknown) => void;
              states: Map<number, unknown>;
              emit: (name: string, args: unknown[]) => void;
            };
          };
        }
      ).__yjsDebug;

      const fakePeerId = debug.awareness.clientID + 9999;
      debug.awareness.states.set(fakePeerId, {
        user: {
          userId: 'fake-peer-uuid',
          displayName: 'Fake Peer',
          color: '#22c55e',
        },
      });
      // Fire the 'change' / 'update' events the hook subscribes to.
      debug.awareness.emit('change', [
        { added: [fakePeerId], updated: [], removed: [] },
        'simulated',
      ]);
    });

    cy.get('[data-testid="presence-chips"]', { timeout: 5000 }).should('exist');
    cy.get('[data-testid="presence-chip"]').should('have.length', 1);
    cy.get('[data-testid="presence-chip"]').first().should('have.attr', 'title', 'Fake Peer');
  });
});
