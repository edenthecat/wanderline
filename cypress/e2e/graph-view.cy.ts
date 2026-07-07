// Covers the Story Graph tab. Renders the storyGraph as a
// React Flow diagram with dagre-laid-out nodes, edge labels for
// choices/diverts, and visual highlights for the start node + missing
// targets.

describe('Story graph view', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Graph View Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit(`/projects/${projectId}`);
    cy.contains('Graph View Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Graph').click();
  });

  it('renders the Graph workspace with the legend hint', () => {
    // After the restyle the section header was replaced with the
    // workspace toolbar that already shows "Graph". Assert the new
    // hint text from the legend instead of the removed h2.
    cy.contains('Click a node for details').should('be.visible');
  });

  it('mounts a React Flow canvas with pan/zoom controls and a mini-map', () => {
    cy.get('[data-testid="story-graph"]').should('be.visible');
    // React Flow renders these without a custom test-id; assert on their
    // canonical class names from the @xyflow/react CSS.
    cy.get('[data-testid="story-graph"]').within(() => {
      cy.get('.react-flow').should('exist');
      cy.get('.react-flow__controls').should('exist');
      cy.get('.react-flow__minimap').should('exist');
    });
  });

  it('renders one node per knot + stitch in the storyGraph', () => {
    cy.get('[data-testid="story-graph"]')
      .find('.react-flow__node')
      .should('have.length.at.least', 9);
  });

  it('shows the start knot with the start chip', () => {
    cy.get('[data-testid="story-graph"]').contains('_intro').should('exist');
    // The card-style node renders the type chip as text "start" on
    // the start node (was previously "(start)" appended to the label).
    cy.get('[data-testid="story-graph"]')
      .find('.graph-node-chip')
      .contains('start')
      .should('exist');
  });

  it('renders missing-target nodes flagged as missing', () => {
    cy.get('[data-testid="story-graph"]').contains('actual_credits').should('exist');
    cy.get('[data-testid="story-graph"]').find('.graph-node-card.is-missing').should('exist');
  });

  it('renders per-choice rows inside the node card', () => {
    // Graph v2 moved choice text from edge labels into per-row
    // entries on the source card; each row anchors its own source
    // handle so drag-to-retarget targets that specific choice.
    cy.get('[data-testid="story-graph"]')
      .find('.graph-node-choice-text')
      .should('have.length.at.least', 1);
    cy.get('[data-testid="story-graph"]').contains('.graph-node-choice-text', /Enter|Leave/);
  });

  it('exposes a search input that highlights matched nodes', () => {
    cy.get('[data-testid="graph-search"]').type('intro');
    cy.get('[data-testid="story-graph"]').find('.graph-node-card.is-matched').should('exist');
    // Non-matches dim out so the eye lands on the match.
    cy.get('[data-testid="story-graph"]').find('.graph-node-card.is-unmatched').should('exist');
    cy.get('[data-testid="graph-search"]').clear();
    cy.get('[data-testid="story-graph"]').find('.graph-node-card.is-matched').should('not.exist');
  });

  it('toggles the dim-unreachable overlay', () => {
    cy.get('[data-testid="graph-dim-toggle"]').check();
    // Without a truly orphan node in the fixture this might be a
    // weak assertion; we only assert the toggle works (i.e. the
    // checkbox is checkable) and no DOM error fires.
    cy.get('[data-testid="graph-dim-toggle"]').should('be.checked');
    cy.get('[data-testid="graph-dim-toggle"]').uncheck();
  });

  it('lights up nodes + edges along a shift-click traced path', () => {
    // _intro → her is the first choice in the fixture (auto-created
    // implicit start node, then "Enter site -> her"). Shift-clicking
    // both should produce a 2-node path with one highlighted edge.
    cy.get('[data-testid="story-graph"]').contains('.graph-node-card', '_intro').click({
      shiftKey: true,
    });
    cy.get('[data-testid="story-graph"]').contains('.graph-node-card', 'her').click({
      shiftKey: true,
    });
    cy.get('[data-testid="story-graph"]').find('.graph-node-card.is-on-path').should('exist');
    cy.get('[data-testid="story-graph"]')
      .find('.react-flow__edge.graph-edge-on-path')
      .should('exist');
    cy.contains('button', 'Clear').click();
    cy.get('[data-testid="story-graph"]').find('.graph-node-card.is-on-path').should('not.exist');
  });

  it('toggles layout direction and re-runs auto-layout on reset', () => {
    // TB is the default; LR puts the segmented control's other button
    // into the active state and re-flows dagre. We can't easily
    // measure the new positions but we can assert the active class
    // moves and the canvas still has the same set of nodes after.
    cy.get('[data-testid="graph-rankdir-tb"]').should('have.class', 'is-active');
    cy.get('[data-testid="graph-rankdir-lr"]').click();
    cy.get('[data-testid="graph-rankdir-lr"]').should('have.class', 'is-active');
    cy.get('[data-testid="graph-rankdir-tb"]').should('not.have.class', 'is-active');
    cy.get('[data-testid="story-graph"]')
      .find('.react-flow__node')
      .should('have.length.at.least', 9);
    cy.get('[data-testid="graph-rankdir-tb"]').click();
    cy.get('[data-testid="graph-rankdir-tb"]').should('have.class', 'is-active');
    // Reset layout: position-reset is hard to assert without
    // dragging first (awkward in Cypress) but we can at least guard
    // against a regression where Reset gets accidentally wired to
    // setRankdir — assert the active direction is unchanged by Reset.
    cy.get('[data-testid="graph-reset-layout"]').should('be.visible').click();
    cy.get('[data-testid="graph-rankdir-tb"]').should('have.class', 'is-active');
    cy.get('[data-testid="graph-rankdir-lr"]').should('not.have.class', 'is-active');
    cy.get('[data-testid="story-graph"]')
      .find('.react-flow__node')
      .should('have.length.at.least', 9);
  });

  it('does not show the retarget-error banner on a clean view', () => {
    // The banner only renders when retargetError state is non-null
    // (set by applyRetarget's catch). A clean visit should not show
    // it. Real failure-case coverage requires simulating a drag,
    // which is awkward in Cypress; this is the negative gate.
    cy.get('[data-testid="graph-retarget-error"]').should('not.exist');
  });

  it('renders an END terminal sink', () => {
    cy.get('[data-testid="story-graph"]')
      .find('.graph-node-terminal')
      .contains('END')
      .should('exist');
  });

  it('shows an empty state when the project has no story', () => {
    cy.apiCreateProject('Graph Empty Test').then((id) => {
      cy.visit(`/projects/${id}`);
      cy.contains('button', 'Graph').click();
      cy.contains('Upload a story file to see its node graph').should('be.visible');
      cy.get('[data-testid="story-graph"]').should('not.exist');
    });
  });
});
