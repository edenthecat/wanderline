// Covers the per-node timing fields in NodeDetail, plus the "timing"
// badge that surfaces in node headers when the saved values diverge
// from the player's runtime defaults.
//
// Auto-advance itself is no longer a per-node control — it is a single
// project setting under Settings > Player display, covered by the
// frontend unit tests. The delay fields remain per-node: they govern
// the pause when advancing does happen.

const PREROLL = 'Pre-roll delay before voiceover (ms)';
const EXTRA = 'Extra pause before auto-advance (ms)';
const AUTODELAY = 'Auto-advance delay (ms)';

const numberField = (label: string) => cy.contains('label', label).find('input[type=number]');

describe('Node timing & auto-advance controls', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Node Timing Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit(`/projects/${projectId}`);
    cy.contains('h1', 'Node Timing Test', { timeout: 15000 }).should('be.visible');
    cy.contains('.node-header', '_intro', { timeout: 10000 }).click();
  });

  it('renders the timing fields with runtime defaults', () => {
    cy.contains('Timing & auto-advance').should('be.visible');
    numberField(PREROLL).should('have.value', '0');
    numberField(EXTRA).should('have.value', '0');
    numberField(AUTODELAY).should('have.value', '2000');
  });

  it('saves custom timing, reflects it via API, and shows the "timing" badge', () => {
    // Use {selectall} rather than .clear() — clearing a controlled
    // number input lets React re-render to the default ('0') before
    // we finish typing, producing values like '5000' instead of '500'.
    numberField(PREROLL).type('{selectall}500');
    numberField(AUTODELAY).type('{selectall}5000');
    cy.contains('button', 'Save timing').click();
    cy.contains('button', 'Save timing').should('be.disabled');

    cy.request('GET', `/api/projects/${projectId}/metadata/_intro`).then((res) => {
      expect(res.body.metadata.delayBeforeMs).to.eq(500);
      expect(res.body.metadata.autoAdvanceDelayMs).to.eq(5000);
    });

    // Badge appears next to the node id (timing diverges from defaults)
    cy.contains('.node-header', '_intro').within(() => {
      cy.contains('.badge', /timing/i).should('be.visible');
    });
  });

  it('rounds decimals and clamps runaway values via the parseMs helper', () => {
    numberField(PREROLL).type('{selectall}0.5');
    // parseMs uses Math.round, which rounds halves toward +∞ in JS
    // (round-half-up — NOT banker's rounding), so 0.5 lands on 1.
    numberField(PREROLL).should('have.value', '1');

    numberField(PREROLL).type('{selectall}1e10');
    // Capped at MAX_TIMING_MS (60_000).
    numberField(PREROLL).should('have.value', '60000');
  });

  it('discards in-progress edits without touching the server', () => {
    // Reset _intro to defaults so the assertion isn't affected by
    // the previous test's save (tests share a single project under
    // a `before` block).
    cy.request('PUT', `/api/projects/${projectId}/metadata/_intro`, {
      delayBeforeMs: 0,
      delayAfterMs: 0,
      autoAdvance: true,
      autoAdvanceDelayMs: 2000,
    });
    cy.reload();
    cy.contains('.node-header', '_intro').click();

    numberField(PREROLL).type('{selectall}1500');
    cy.contains('button', 'Discard changes').should('be.visible').click();
    numberField(PREROLL).should('have.value', '0');

    cy.request('GET', `/api/projects/${projectId}/metadata/_intro`).then((res) => {
      expect(res.body.metadata.delayBeforeMs).to.eq(0);
    });
  });
});
