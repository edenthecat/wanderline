// live signal broadcasts for audio assignments +
// node metadata. The signal channel is a small Y.Map<string,
// number> under `__signals__` on the project's shared Y.Doc; a
// successful mutation in one tab writes a fresh timestamp under
// the relevant key, and peers observing that key re-fetch from
// REST. Wire-level relay is already covered by collab-server
// jest; this spec asserts the consumer hook actually re-fetches.
//
// The hook skips updates with transaction.local=true to avoid a
// double-fetch on the originating tab (the caller's REST mutation
// has already refreshed local state). So this spec has to simulate
// a REMOTE peer bump — direct doc.set() on the page's doc would be
// local and silently ignored, which would mask the wiring being
// broken.

describe('Yjs live signals', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Live Signals Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('AudioTab refetches assignments when a peer bumps the audio-assignments signal', () => {
    cy.visit(`/projects/${projectId}?yjsDemo=1`);
    cy.get('[data-testid="yjs-status"]', { timeout: 10000 }).should('have.text', 'connected');
    // Switch to the Audio tab so AudioTab is mounted and listening.
    cy.contains('button', /audio/i).click();
    // AudioTab's mounted heading — case-sensitive substring per Cypress
    // default. AudioTab currently renders `<h2>Audio files</h2>` (lower-
    // case f); if the copy changes, sync here.
    cy.contains('Audio files', { timeout: 10000 }).should('be.visible');

    // Stub the fetch endpoint so we can detect a re-fetch.
    cy.intercept('GET', `/api/projects/${projectId}/audio/assignments*`).as('refetchAssign');

    cy.window().then((win) => simulateRemoteSignal(win, 'audio-assignments'));

    cy.wait('@refetchAssign', { timeout: 5000 });
  });

  it('StoryTab refetches metadata when a peer bumps the metadata signal', () => {
    cy.visit(`/projects/${projectId}?yjsDemo=1`);
    cy.get('[data-testid="yjs-status"]', { timeout: 10000 }).should('have.text', 'connected');
    // StoryTab is the default tab; wait for its initial metadata
    // GET to finish before we start observing follow-up requests.
    cy.intercept('GET', `/api/projects/${projectId}/metadata`).as('refetchMeta');

    cy.window().then((win) => simulateRemoteSignal(win, 'metadata'));

    cy.wait('@refetchMeta', { timeout: 5000 });
  });
});

/**
 * Simulate a remote peer bumping the named signal on the page's
 * shared Y.Doc. Builds an update on a SEPARATE Y.Doc (the page's
 * `yjs` module is reachable via __yjsDebug.Y), encodes it as a
 * binary patch, then applies it back into the page's doc. Y.js
 * marks the resulting transaction as non-local, which is what the
 * useLiveSignal observer requires to re-fetch.
 */
function simulateRemoteSignal(win: Window, key: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const debug = (win as any).__yjsDebug;
  const Y = debug.Y;
  const peer = new Y.Doc();
  peer.getMap('__signals__').set(key, Date.now());
  const update = Y.encodeStateAsUpdate(peer);
  Y.applyUpdate(debug.doc, update, 'remote-test');
}
