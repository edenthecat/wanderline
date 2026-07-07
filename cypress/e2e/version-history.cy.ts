// Version history end-to-end: create a snapshot, take a
// destructive action (re-upload a different ink), then restore and
// verify the original content is back. Also verify the auto
// "Before ink upload" snapshot is captured automatically.

describe('Version history', () => {
  let projectId: string;
  const STORY_A = `=== _intro ===\nOriginal A content\n+ [Go on] -> END`;
  const STORY_B = `=== _intro ===\nOverwritten B content\n+ [Go on] -> END`;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Version History Test').then((id) => {
      projectId = id;
      cy.apiUploadInk(id, STORY_A);
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('captures a manual snapshot and restores it after a destructive ink upload', () => {
    cy.visit(`/projects/${projectId}`);
    cy.contains('Version History Test', { timeout: 15000 }).should('be.visible');

    // Open the History tab.
    cy.contains('button', 'History').click();
    cy.get('[data-testid="history-tab"]', { timeout: 5000 }).should('be.visible');

    // Save a manual snapshot.
    cy.get('input[aria-label="Snapshot label"]').type('Pristine A');
    cy.get('[data-testid="snapshot-create-btn"]').click();
    cy.contains('[data-testid="snapshot-row"]', 'Pristine A', { timeout: 5000 }).should(
      'be.visible',
    );

    // Replace the ink with a different story via API — that should
    // trigger the auto-snapshot "Before ink upload".
    cy.request('POST', `/api/projects/${projectId}/ink`, { source: STORY_B })
      .its('status')
      .should('eq', 200);

    // Re-render history list.
    cy.get('[data-testid="history-tab"]').then(() => {
      cy.reload();
      cy.contains('button', 'History').click();
    });
    cy.get('[data-testid="snapshot-row"]', { timeout: 5000 }).should('have.length.at.least', 2);
    cy.get('[data-testid="snapshot-row"]').first().should('contain.text', 'Before ink upload');

    // Restore the manual "Pristine A" snapshot via direct API call —
    // the UI restore button uses window.confirm which Cypress can
    // auto-accept, but bypassing the dialog avoids the timing race.
    cy.contains('[data-testid="snapshot-row"]', 'Pristine A')
      .find('[data-testid="snapshot-restore-btn"]')
      .then(($btn) => {
        const win = $btn[0].ownerDocument.defaultView!;
        cy.stub(win, 'confirm').returns(true);
        cy.wrap($btn).click();
      });

    // After restore, the API should be returning STORY_A.
    cy.request('GET', `/api/projects/${projectId}`).then((resp) => {
      const introText = resp.body?.project?.story_graph?.nodes?._intro?.content?.[0]?.text;
      expect(introText).to.eq('Original A content');
    });
  });
});
