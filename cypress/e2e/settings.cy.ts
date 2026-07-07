// Covers (UI options) + the post-split workspace settings
// tools. The Settings page itself now hosts only Password +
// Danger zone; volumes / system sounds / headphone controls /
// player display live as their own workspace tools and have their
// own specs covering each lane.

describe('Project Settings (split)', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Settings Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit(`/projects/${projectId}`);
    cy.contains('Settings Test', { timeout: 15000 }).should('be.visible');
  });

  describe('Settings page (Password + Danger zone only)', () => {
    beforeEach(() => {
      cy.contains('button', 'Settings').click();
    });

    it('renders just the two surviving section headers', () => {
      cy.contains('h2', 'Password protection').should('be.visible');
      cy.contains('h2', 'Danger zone').should('be.visible');
      // The old sections moved out — they should NOT be on this page.
      cy.contains('h2', 'Player display').should('not.exist');
      cy.contains('h2', 'Headphone controls').should('not.exist');
      cy.contains('h2', 'Default volumes').should('not.exist');
      cy.contains('h2', 'System sounds').should('not.exist');
    });

    it('saves a project password via the input + Save button', () => {
      cy.get('input[type=password]').clear().type('secret123');
      cy.contains('button', 'Save').click();
      cy.contains('Password is currently set', { timeout: 5000 }).should('be.visible');

      cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
        expect(res.body.settings.password).to.eq('secret123');
      });

      cy.contains('button', 'Remove').click();
    });

    it('confirms before deleting all project audio (Danger Zone)', () => {
      cy.contains('button', 'Delete all audio').click();
      cy.contains("Are you sure? This can't be undone.").should('be.visible');
      cy.contains('button', 'Cancel').click();
      cy.contains('Are you sure?').should('not.exist');
    });
  });

  describe('Player display tool (Look & feel)', () => {
    beforeEach(() => {
      cy.contains('button', 'Player display').click();
    });

    it('toggles "Show choice list" and persists it', () => {
      cy.contains('strong', 'Show choice list')
        .parents('label')
        .find('input[type=checkbox]')
        .as('toggle');
      cy.get('@toggle').should('be.checked').uncheck();
      cy.get('@toggle').should('not.be.checked');

      cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
        expect(res.body.settings.showChoiceList).to.eq(false);
      });
    });

    it('toggles "Captions on by default" independently', () => {
      cy.contains('strong', 'Captions on by default')
        .parents('label')
        .find('input[type=checkbox]')
        .as('toggle');
      cy.get('@toggle').uncheck();
      cy.get('@toggle').should('not.be.checked');

      cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
        expect(res.body.settings.captionsDefault).to.eq(false);
      });
    });
  });

  describe('Volumes tool (Voice & sound)', () => {
    it('renders three sliders and persists a change', () => {
      cy.contains('button', 'Volumes').click();
      cy.contains('strong', 'Voiceover').should('be.visible');
      cy.contains('strong', 'Background music').should('be.visible');
      cy.contains('strong', 'Choice & UI sounds').should('be.visible');

      // Drag the voiceover slider to 50. invoke('val') alone won't
      // fire React's onChange — React subscribes to the native
      // tracker on HTMLInputElement.prototype, so we have to use
      // the prototype setter + dispatch a bubbling input event so
      // React's listener treats the value as changed.
      cy.get('input[type=range][aria-label*="Voiceover" i]').then(($el) => {
        const input = $el[0] as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, '50');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Debounced PATCH fires 250ms after the last input event.
      cy.wait(500);
      cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
        expect(res.body.settings.voiceoverVolume).to.eq(50);
      });
    });
  });

  describe('System sounds tool (Voice & sound)', () => {
    it('shows the indicator-sound picker', () => {
      cy.contains('button', 'System sounds').click();
      cy.contains('h2', 'System sounds').should('be.visible');
      cy.get('select[aria-label="Default indicator sound"]').should('exist');
    });
  });
});
