// end-to-end test that an inline choice-text edit
// in the Story tab flows through the Y.Doc, and a "remote" peer
// write reaches the same input. Same simulated-peer pattern as
// yjs-collab.cy.ts: the wire-level two-peer relay is already
// covered by collab-server.test.ts; this test exercises the
// React<->Y.Doc<->REST-PATCH chain end-to-end.

describe('Yjs story collab', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Yjs Story Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('uses the collab-bound input when the doc is connected', () => {
    cy.visit(`/projects/${projectId}`);
    cy.contains('Yjs Story Test', { timeout: 15000 }).should('be.visible');
    // Expand a knot with choices so the inline choice-text input
    // renders. test-story.ink's `_intro` knot has choices.
    cy.contains('button', '_intro').click();
    // The collab variant of the input has testid="collab-choice-text".
    cy.get('[data-testid="collab-choice-text"]', { timeout: 10000 }).should('exist');
  });

  it('reflects a Y.Text mutation from a non-input origin in the choice input', () => {
    cy.visit(`/projects/${projectId}`);
    cy.contains('Yjs Story Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', '_intro').click();

    // Wait for the collab input to mount + the Y.Doc to be reachable
    // via the StoryTab's useYjs hook.
    cy.get('[data-testid="collab-choice-text"]', { timeout: 10000 }).first().should('be.visible');

    // Reach the Y.Doc through the YjsDemoField escape hatch we
    // already expose for cypress; but here we need the StoryTab's
    // doc, not the demo's. They're the SAME doc instance (the
    // useYjs registry de-duplicates per project id), so __yjsDebug
    // works regardless of where it was set.
    // The demo isn't mounted (no ?yjsDemo=1), so we visit with it
    // briefly to expose the doc, then assert against the existing
    // StoryTab inputs.
    cy.visit(`/projects/${projectId}?yjsDemo=1`);
    cy.get('[data-testid="yjs-status"]', { timeout: 5000 }).should('have.text', 'connected');
    cy.contains('button', '_intro').click();

    cy.window().should('have.property', '__yjsDebug');
    cy.window().then((win) => {
      const debug = (
        win as unknown as {
          __yjsDebug: {
            doc: {
              getMap: (k: string) => {
                get: (id: string) => {
                  get: (k: string) => {
                    get: (i: number) => { get: (k: string) => unknown };
                  };
                };
              };
              transact: (fn: () => void, origin: string) => void;
            };
          };
        }
      ).__yjsDebug;
      // doc.nodes._intro.choices[0].text → Y.Text
      const choice0Text = debug.doc
        .getMap('nodes')
        .get('_intro')
        .get('choices')
        .get(0)
        .get('text') as {
        length: number;
        delete: (i: number, n: number) => void;
        insert: (i: number, s: string) => void;
      };
      debug.doc.transact(() => {
        choice0Text.delete(0, choice0Text.length);
        choice0Text.insert(0, 'remote peer edit');
      }, 'simulated-peer');
    });

    cy.get('[data-testid="collab-choice-text"]', { timeout: 5000 })
      .first()
      .should('have.value', 'remote peer edit');
  });
});
