// Covers (unreachable / missing-target warnings) and // (parser errors with line numbers + humanized hints + Ink-docs link).
// Uploads a deliberately-broken .ink so the storyGraph carries
// errors/warnings and verifies the editor surfaces them clearly.

const BROKEN_INK = `=== start ===
Welcome.
+ Go to nowhere -> ghost
+ Skip -> skipped_node

=== reachable_orphan ===
This knot is never reached.
-> END

=== empty_knot ===
`;

describe('Validation panel', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Validation Panel Test').then((id) => {
      projectId = id;
      cy.apiUploadInk(id, BROKEN_INK);
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit(`/projects/${projectId}`);
    cy.contains('h1', 'Validation Panel Test', { timeout: 15000 }).should('be.visible');
  });

  it('summarizes errors and warnings in the panel header', () => {
    cy.get('[data-testid="validation-panel"]')
      .should('be.visible')
      .within(() => {
        cy.contains(/5 warnings/i).should('be.visible');
      });
  });

  it('shows raw parser titles for each issue', () => {
    cy.get('[data-testid="validation-panel"]').within(() => {
      cy.contains('Divert target "ghost" not found').should('be.visible');
      cy.contains('Divert target "skipped_node" not found').should('be.visible');
      cy.contains('Node "reachable_orphan" is not reachable from the start').should('be.visible');
      cy.contains('Node "empty_knot" is not reachable from the start').should('be.visible');
      cy.contains('Node "empty_knot" has no content, choices, or divert').should('be.visible');
    });
  });

  it('renders humanized hints + Ink writing reference links', () => {
    cy.get('[data-testid="validation-panel"]').within(() => {
      cy.contains('Check spelling, or add the missing').should('be.visible');
      // Ink docs link only on the missing-target items
      cy.contains('Ink writing reference').should('be.visible');
    });
  });

  it('surfaces line numbers for issues that carry them', () => {
    cy.get('[data-testid="validation-panel"]').within(() => {
      // empty_knot is declared at line 10, reachable_orphan at line 6
      cy.contains('line 6').should('be.visible');
      cy.contains('line 10').should('be.visible');
    });
  });

  it('jumps to the offending node when the nodeId link is clicked', () => {
    cy.get('[data-testid="validation-panel"]').contains('button', 'empty_knot').first().click();
    cy.get('[data-node-id="empty_knot"]').should('be.visible');
  });

  it('hides the panel when the uploaded story has no validation issues', () => {
    // Spin up a clean project with the well-formed fixture; the panel
    // should not render at all.
    cy.apiCreateProject('Validation Clean Test').then((id) => {
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
      cy.visit(`/projects/${id}`);
      cy.contains('Story nodes', { timeout: 15000 }).should('be.visible');
      cy.get('[data-testid="validation-panel"]').should('not.exist');
    });
  });
});
