// Regression: bulk audio upload failed in production when the
// combined payload exceeded Cloud Run's ~32 MiB request-body
// limit. The frontend now chunks into batches of ~20 MiB; these
// tests verify (a) a small batch still works end-to-end and (b)
// the client actually splits when the cumulative payload would
// exceed the threshold.

describe('Bulk audio upload (chunked)', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Bulk Audio Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('accepts a chunked bulk upload of multiple small files', () => {
    cy.window().then(async (win) => {
      const form = new win.FormData();
      const bytes = mp3Bytes(200);
      for (let i = 0; i < 5; i++) {
        const blob = new win.Blob([bytes], { type: 'audio/mpeg' });
        form.append('audio', blob, `f${i}.mp3`);
      }
      form.append('category', 'voiceover');
      const res = await win.fetch(`/api/projects/${projectId}/audio/bulk`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      expect([200, 201]).to.include(res.status);
      const body = await res.json();
      expect(body.totalUploaded).to.eq(5);
    });
  });

  it('rejects an empty bulk upload with 400', () => {
    cy.window().then(async (win) => {
      const form = new win.FormData();
      form.append('category', 'voiceover');
      const res = await win.fetch(`/api/projects/${projectId}/audio/bulk`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      expect(res.status).to.eq(400);
    });
  });

  // Verify the client's chunking by driving bulkUploadAudio with a
  // synthetic file list that crosses the partition threshold, and
  // intercepting the resulting POSTs. We import the helper directly
  // from the running dev bundle via window.__BULK_TEST__ in the app.
  // Easier path here: hit the client behavior via cy.intercept on
  // the raw endpoint after firing the file input.
  it('splits the upload into multiple POSTs when total payload exceeds the chunk target', () => {
    cy.intercept('POST', `/api/projects/${projectId}/audio/bulk`).as('bulk');
    cy.visit(`/projects/${projectId}`);
    cy.contains('Bulk Audio Test', { timeout: 15000 }).should('be.visible');
    // Open the Sound group's Audio tool. With the sidebar on desktop,
    // it's a button labelled "Audio" in the left rail.
    cy.contains('button', 'Audio').click();

    // Two 12 MiB files cumulative > 20 MiB threshold → expect 2 POSTs.
    // 1 KiB chunks are fine to fake an "audio file" of n bytes — the
    // backend validates mime, not contents.
    const sizeBytes = 12 * 1024 * 1024;
    cy.get('input[type=file][accept="audio/*"]')
      .last()
      .then(($input) => {
        const blobA = new Blob([new Uint8Array(sizeBytes)], { type: 'audio/mpeg' });
        const blobB = new Blob([new Uint8Array(sizeBytes)], { type: 'audio/mpeg' });
        const dt = new DataTransfer();
        const fileA = new File([blobA], 'big-a.mp3', { type: 'audio/mpeg' });
        const fileB = new File([blobB], 'big-b.mp3', { type: 'audio/mpeg' });
        dt.items.add(fileA);
        dt.items.add(fileB);
        const input = $input[0] as HTMLInputElement;
        Object.defineProperty(input, 'files', { value: dt.files });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

    // Both chunks fire. The endpoint may 200 or 413 in CI depending
    // on the local request-body cap — we only care that the FRONTEND
    // sent two separate POSTs, proving the chunking ran.
    cy.wait('@bulk');
    cy.wait('@bulk');
  });
});

function mp3Bytes(padding: number): Uint8Array {
  const head = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  const out = new Uint8Array(head.length + padding);
  out.set(head, 0);
  return out;
}
