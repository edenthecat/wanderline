// Covers the configurable Bluetooth / headphone controls in
// SettingsTab. Only verifies the editor → settings persistence path;
// the actual MediaSession key dispatch happens against real hardware
// (or browser dev-tools media controls) which Cypress can't simulate.

describe('Headphone control mapping', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Bluetooth Controls Test').then((id) => {
      projectId = id;
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.intercept('PATCH', /\/api\/projects\/.*\/settings/).as('saveSettings');
    cy.visit(`/projects/${projectId}`);
    cy.contains('Bluetooth Controls Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Headphone controls').click();
  });

  it('renders next/previous track selects with the default actions', () => {
    cy.contains('h2', 'Headphone controls').should('be.visible');
    cy.contains('label', 'When Next Track is pressed')
      .find('select')
      .should('have.value', 'choice1');
    cy.contains('label', 'When Previous Track is pressed')
      .find('select')
      .should('have.value', 'choice2');
  });

  it('lets the user remap next track and persists to the API', () => {
    cy.contains('label', 'When Next Track is pressed').find('select').select('confirm');
    cy.wait('@saveSettings');
    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.bluetoothControls.nextTrack).to.eq('confirm');
    });
  });

  it('lets the user remap previous track to go_back', () => {
    cy.contains('label', 'When Previous Track is pressed').find('select').select('go_back');
    cy.wait('@saveSettings');
    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.bluetoothControls.previousTrack).to.eq('go_back');
    });
  });

  it('forwards bluetoothControls through the story preview payload', () => {
    cy.fixture('test-story.ink').then((content) => {
      cy.apiUploadInk(projectId, content);
    });
    cy.contains('label', 'When Next Track is pressed').find('select').select('cycle_choices');
    cy.wait('@saveSettings');
    cy.contains('label', 'When Previous Track is pressed').find('select').select('cycle_choices');
    cy.wait('@saveSettings');

    // The player reads window.__WANDERLINE_STORY__ from the preview
    // shell. Hit the preview HTML and grep — easier than puppeteering
    // an iframe.
    cy.request(`/api/projects/${projectId}/preview`).then((res) => {
      expect(res.body).to.include('cycle_choices');
    });
  });

  it('preserves the previousTrack value when only nextTrack is patched', () => {
    // Regression: the backend PATCH used to shallow-merge with the
    // JSONB `||` operator, which replaces nested objects wholesale.
    // Sending { bluetoothControls: { nextTrack: 'confirm' } } would
    // silently wipe previousTrack. The mergeSettings helper now
    // performs a key-by-key merge for bluetoothControls.
    cy.contains('label', 'When Previous Track is pressed').find('select').select('go_back');
    cy.wait('@saveSettings');
    cy.contains('label', 'When Next Track is pressed').find('select').select('divert');
    cy.wait('@saveSettings');
    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.bluetoothControls.nextTrack).to.eq('divert');
      // The killer: previousTrack must NOT have been dropped by the
      // nextTrack-only PATCH that ran second.
      expect(res.body.settings.bluetoothControls.previousTrack).to.eq('go_back');
    });
  });

  it('describes the fixed click-gesture mappings', () => {
    cy.contains('Fixed mappings:').should('be.visible');
    cy.contains('Play / Pause').should('be.visible');
    cy.contains('double-press').should('be.visible');
    cy.contains('triple-press').should('be.visible');
  });
});
