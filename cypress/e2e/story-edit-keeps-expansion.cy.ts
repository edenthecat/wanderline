// Regression: when a choice-text edit fires the REST PATCH that
// triggers a project re-fetch, the StoryTab's expanded-knot state
// must NOT reset. Before the fix, every keystroke would unmount
// + remount the tab content (because the page flipped to its
// "Loading project…" branch), causing the active knot to collapse
// and the user to lose their place.

describe('Story tab keeps expansion across child-save refetches', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Expansion Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('keeps the edited knot expanded after a choice text save', () => {
    cy.visit(`/projects/${projectId}`);
    cy.contains('Expansion Test', { timeout: 15000 }).should('be.visible');
    // Expand a knot with choices.
    cy.contains('button', '_intro').click();
    cy.get('[data-testid="collab-choice-text"]', { timeout: 10000 }).first().should('be.visible');

    // Edit the first choice text. Fire input + change so the
    // legacy REST PATCH triggers, which is what would have
    // collapsed the knot before the fix.
    cy.get('[data-testid="collab-choice-text"]')
      .first()
      .then(($el) => {
        const input = $el[0] as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, 'expansion test edit');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

    // After the debounced save + re-fetch, the knot should
    // still be expanded — the input is still present.
    cy.get('[data-testid="collab-choice-text"]', { timeout: 5000 })
      .first()
      .should('have.value', 'expansion test edit');

    // The toggle indicator on the _intro header should still
    // show the "expanded" arrow.
    cy.contains('button', '_intro').find('.node-toggle').should('have.text', '▼');
  });
});
