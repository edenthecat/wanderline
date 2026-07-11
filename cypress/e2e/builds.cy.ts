describe('Builds', () => {
  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Builds Test').then((id) => {
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit('/');
    cy.contains('Builds Test', { timeout: 15000 }).click();
    cy.contains('h1', 'Builds Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Builds').click();
  });

  it('should show the builds view', () => {
    cy.contains(/Builds/i).should('be.visible');
  });

  it('should have a start build button', () => {
    cy.contains('button', 'Start build').should('be.visible');
  });

  it('should start a new build', () => {
    cy.contains('button', 'Start build').click();
    cy.contains(/pending|processing|completed/i, {
      timeout: 30000,
    }).should('be.visible');
  });

  it('should show build progress or completion', () => {
    cy.contains(/completed|failed|processing/i, {
      timeout: 90000,
    }).should('be.visible');
  });

  // build management UI additions
  it('exposes a size column and a Details toggle on completed builds', () => {
    // Wait for at least one build to complete
    cy.contains('.badge', /completed/i, { timeout: 90000 }).should('be.visible');

    // Size column header
    cy.contains('th', 'Size').should('be.visible');

    // Completed row should have a Details button
    cy.contains('tr', /completed/i).within(() => {
      cy.contains('button', 'Details').should('be.visible');
    });
  });

  it('shows the audio / code / total breakdown when Details is expanded', () => {
    cy.contains('.badge', /completed/i, { timeout: 90000 }).should('be.visible');
    cy.contains('tr', /completed/i)
      .first()
      .within(() => {
        cy.contains('button', 'Details').click();
      });

    // Expanded row reveals the metric labels
    cy.contains('dt', 'Audio').should('be.visible');
    cy.contains('dt', /Code/).should('be.visible');
    cy.contains('dt', /Total/).should('be.visible');
  });

  it('exposes the "stored / max" count and a per-build preview note', () => {
    cy.contains(/\d+ of \d+ builds stored/i).should('be.visible');
    // copy was updated when per-build preview shipped.
    cy.contains(/Each completed build has a Preview link/i).should('be.visible');
  });

  // pin toggle on completed builds. Star toggles between
  // "☆ Pin" and "★ Pinned" and reflects the row's pinned marker in
  // the build-number cell. aria-pressed follows the state so the
  // button is a real toggle for assistive tech.
  it('toggles pin state on a completed build via the Pin button', () => {
    cy.contains('.badge', /completed/i, { timeout: 90000 }).should('be.visible');

    cy.contains('tr', /completed/i)
      .first()
      .within(() => {
        // Initial state: unpinned. Pin button reads "☆ Pin".
        cy.get('button[aria-pressed]')
          .filter(':contains("Pin")')
          .should('have.attr', 'aria-pressed', 'false')
          .click();

        // After the API returns + reload, the same button reads
        // "★ Pinned" and aria-pressed flips to true.
        cy.get('button[aria-pressed="true"]', { timeout: 15000 })
          .filter(':contains("Pinned")')
          .should('exist');

        // The build-number cell picks up the ★ marker.
        cy.get('.pin-marker').should('exist');
      });

    // Reload and confirm the pin persisted across a page refresh.
    cy.reload();
    cy.contains('button', 'Builds').click();
    cy.contains('tr', /completed/i)
      .first()
      .within(() => {
        cy.get('button[aria-pressed="true"]').filter(':contains("Pinned")').should('exist');
        cy.get('.pin-marker').should('exist');
      });

    // Clean up so a later test starting from "unpinned" isn't
    // surprised by the sticky pin.
    cy.contains('tr', /completed/i)
      .first()
      .within(() => {
        cy.get('button[aria-pressed="true"]').filter(':contains("Pinned")').click();
        cy.get('button[aria-pressed="false"]', { timeout: 15000 })
          .filter(':contains("Pin")')
          .should('exist');
      });
  });

  // cancel button only shows on pending/processing rows.
  // Kicks off a fresh build so a live in-flight row exists, then
  // clicks Cancel and asserts the row transitions to 'cancelled'.
  it('cancels an in-flight build via the Cancel button', () => {
    // Start a fresh build so we have an in-flight row to cancel.
    // Wait until the "Start build" button is enabled — the previous
    // test's build may still be settling, and canCreate is false
    // while one is active.
    cy.contains('button', 'Start build', { timeout: 30000 }).should('not.be.disabled').click();

    // Accept the confirm dialog when Cancel fires.
    cy.on('window:confirm', () => true);

    // Intercept the cancel API so we can distinguish two outcomes:
    //   - 200: the pipeline had NOT finished; row transitions to
    //     'cancelled'.
    //   - 409: the pipeline finished before the cancel call landed
    //     (test-story.ink is a 56-line fixture that builds in a
    //     couple seconds — this race is unavoidable in CI). The
    //     button was reachable + wired up, which is the useful
    //     signal; the assertion below relaxes to accept the build's
    //     terminal state instead of insisting on 'cancelled'.
    cy.intercept('POST', '**/api/projects/*/builds/*/cancel').as('cancelBuild');

    // Find the pending/processing row and click Cancel — the button
    // only renders on active rows so this doubles as an assertion
    // that the row is in the right state.
    cy.contains('tr', /pending|processing/i, { timeout: 15000 })
      .first()
      .within(() => {
        cy.contains('button', 'Cancel').click();
      });

    cy.wait('@cancelBuild').then((interception) => {
      const status = interception.response?.statusCode;
      if (status === 200) {
        cy.contains('.badge', /cancelled/i, { timeout: 15000 }).should('be.visible');
      } else {
        // 409 = build reached a terminal state (completed/failed)
        // between the cancel button rendering and the request
        // landing. The row still lands in a terminal badge, we just
        // don't get to pin which one.
        expect(
          status,
          'Cancel API returned 200 (raced then cancelled) or 409 (build finished first)',
        ).to.eq(409);
        cy.contains('.badge', /cancelled|completed|failed/i, { timeout: 15000 }).should(
          'be.visible',
        );
      }
    });
  });

  // per-build preview endpoint
  it('renders a per-build preview from the saved story snapshot', () => {
    cy.contains('.badge', /completed/i, { timeout: 90000 }).should('be.visible');

    // Find the first completed build row and follow its Preview link.
    cy.contains('tr', /completed/i)
      .first()
      .within(() => {
        cy.contains('a', 'Preview')
          .should('have.attr', 'target', '_blank')
          .invoke('attr', 'href')
          .as('previewHref');
      });

    // Hit the endpoint directly — bypassing target=_blank — and assert
    // the HTML carries the build banner and the injected story payload.
    cy.get('@previewHref').then((href) => {
      cy.request(href as unknown as string).then((res) => {
        expect(res.status).to.eq(200);
        expect(res.headers['content-type']).to.match(/text\/html/);
        expect(res.body).to.include('window.__WANDERLINE_STORY__');
        // Banner copy: "Build #N" with the build number injected.
        expect(res.body).to.match(/Build #\d+/);
      });
    });
  });
});
