// collab shadow saver. An in-input edit must
// propagate through the Y.Doc → server → debounced UPDATE →
// story_graph row, so the REST GET endpoint that reads
// story_graph directly from the DB (the same path the preview /
// build pipelines hit) sees the new content. That's the proof
// that we're persisting, not just relaying in memory.

describe('Yjs shadow saver', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Yjs Shadow Save Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('persists a Y.Doc edit into the project_stories row within the debounce window', () => {
    cy.visit(`/projects/${projectId}?yjsDemo=1`);
    cy.get('[data-testid="yjs-status"]', { timeout: 10000 }).should('have.text', 'connected');
    cy.contains('button', '_intro').click();
    cy.get('[data-testid="collab-choice-text"]', { timeout: 10000 }).first().should('be.visible');

    // Drive an edit straight through the Y.Doc so the test is
    // resilient to React's input wiring — we're testing the
    // server-side saver, not React.
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
              transact: (fn: () => void) => void;
            };
          };
        }
      ).__yjsDebug;
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
        choice0Text.insert(0, 'persisted via shadow saver');
      });
    });

    // Default debounce is 2s; give the round-trip + UPDATE a safety margin.
    cy.wait(3500);

    cy.request('GET', `/api/projects/${projectId}`).then((resp) => {
      expect(resp.status).to.eq(200);
      const intro = resp.body?.project?.story_graph?.nodes?._intro;
      expect(intro, 'story_graph contains _intro after shadow save').to.exist;
      expect(intro.choices[0].text).to.eq('persisted via shadow saver');
    });
  });

  it('seed transactions do not trigger a write (story_graph stays byte-stable on connect)', () => {
    // First, isolate this case from the previous one by reading
    // the row, then connect with a fresh tab and ensure the seed
    // pass alone doesn't re-write the row.
    cy.request('GET', `/api/projects/${projectId}`).then((before) => {
      const beforeNodes = JSON.stringify(before.body?.project?.story_graph?.nodes ?? {});
      cy.visit(`/projects/${projectId}?yjsDemo=1`);
      cy.get('[data-testid="yjs-status"]', { timeout: 10000 }).should('have.text', 'connected');
      // Give the seed pass + a debounce window enough time to fire
      // a spurious write if the origin-tag gate is broken.
      cy.wait(3500);
      cy.request('GET', `/api/projects/${projectId}`).then((after) => {
        const afterNodes = JSON.stringify(after.body?.project?.story_graph?.nodes ?? {});
        expect(afterNodes).to.eq(beforeNodes);
      });
    });
  });
});
