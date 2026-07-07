// Author QoL: Story-health panel surfaces unreachable nodes,
// dead-ends, and a word-count + playtime estimate above the node
// list in StoryTab. Walks the parsed story_graph client-side; no
// backend changes.

describe('Story-health panel', () => {
  before(() => {
    cy.setupAdmin();
  });
  beforeEach(() => {
    cy.apiLogin();
  });

  it('renders a "no issues" badge for a clean story and reports a sensible word count', () => {
    const ink = `=== _intro ===
A small story. Just a few words.
+ [Finish] -> END`;
    cy.apiCreateProject('Health clean').then((id) => {
      cy.apiUploadInk(id, ink);
      cy.visit(`/projects/${id}`);
      cy.get('[data-testid="story-health"]', { timeout: 10000 }).should('be.visible');
      cy.get('[data-testid="story-health"]').should('contain.text', 'no issues');
      // The summary line includes a word count and a minute count;
      // assert both are present without pinning exact values.
      // (`.invoke('text')` returns the element's text content so
      // we can regex-match it; `.should('match', ...)` on a jQuery
      // subject is selector matching, not text matching.)
      cy.get('[data-testid="story-health"]')
        .invoke('text')
        .should('match', /\d+\s+words/);
      cy.get('[data-testid="story-health"]')
        .invoke('text')
        .should('match', /~\d+\s+min/);
    });
  });

  it('flags an unreachable node and lets you jump to it', () => {
    // _orphan has no caller anywhere — nothing diverts or chooses
    // into it.
    const ink = `=== _intro ===
The story starts.
+ [Continue] -> END

=== _orphan ===
Never reached.
-> END`;
    cy.apiCreateProject('Health unreachable').then((id) => {
      cy.apiUploadInk(id, ink);
      cy.visit(`/projects/${id}`);
      cy.get('[data-testid="story-health"]', { timeout: 10000 }).should('be.visible');
      cy.get('[data-testid="story-health"]').should('contain.text', 'issue');
      // Expand the panel + click into _orphan.
      cy.get('[data-testid="story-health"] button.story-health-summary').click();
      cy.get('[data-testid="health-unreachable"]')
        .should('be.visible')
        .and('contain.text', '_orphan');
      cy.get('[data-testid="health-unreachable"] button').contains('_orphan').click();
      // After clicking jump-to-node, the orphan's expanded knot is
      // visible in the list.
      cy.contains('button.node-header', '_orphan', { timeout: 5000 }).should('be.visible');
    });
  });
});
