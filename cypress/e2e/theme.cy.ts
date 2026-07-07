// theme editor — store CSS variables / Google Fonts / custom
// CSS on the project, render them into the preview HTML.

describe('Theme editor', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Theme Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.intercept('PATCH', /\/api\/projects\/.*\/settings/).as('saveSettings');
    cy.visit(`/projects/${projectId}`);
    cy.contains('h1', 'Theme Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Theme').click();
  });

  it('renders the color knobs and font inputs', () => {
    cy.contains('h3', 'Colors').should('be.visible');
    cy.get('[data-testid="theme-colors"]')
      .find('input[type=color]')
      .should('have.length.greaterThan', 3);
    cy.contains('h3', 'Fonts').should('be.visible');
    cy.contains('h3', 'Custom CSS').should('be.visible');
  });

  it('persists a color + custom CSS and re-fetches them', () => {
    cy.get('[data-testid="theme-colors"]')
      .contains('label', 'Page background')
      .find('input[type=text]')
      .type('{selectall}#0a0a0a');
    // Cypress treats `{...}` as a special-char sequence; opt out so
    // CSS braces type literally.
    cy.get('[data-testid="theme-custom-css"]').type('.card{border-radius:18px;}', {
      parseSpecialCharSequences: false,
    });
    cy.get('[data-testid="theme-save"]').click();
    cy.wait('@saveSettings');

    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.theme.variables.pageBackground).to.eq('#0a0a0a');
      expect(res.body.settings.theme.customCss).to.contain('border-radius:18px');
    });
  });

  it('injects the theme + Google Fonts link into the preview HTML', () => {
    // FontPicker: type into the search field + click "Inter" from the
    // dropdown. The picker mirrors the typed text into the bound
    // value so this also works if the user hand-types a family name
    // that isn't in the catalog.
    cy.get('[data-testid="theme-body-font"]').find('input').type('Inter');
    cy.get('[data-testid="theme-body-font-dropdown"]').contains('Inter').first().click();
    cy.get('[data-testid="theme-save"]').click();
    cy.wait('@saveSettings');

    cy.request(`/api/projects/${projectId}/preview`).then((res) => {
      expect(res.body).to.match(/data-wanderline-theme/);
      expect(res.body).to.match(/fonts\.googleapis\.com\/css2\?family=Inter/);
    });
  });

  // follow-up: searchable font picker
  it('filters the FontPicker dropdown as the user types', () => {
    cy.get('[data-testid="theme-body-font"]').find('input').click();
    cy.get('[data-testid="theme-body-font-dropdown"]').should('be.visible');
    // Lots of fonts visible initially.
    cy.get('[data-testid="theme-body-font-dropdown"] [role="option"]').should(
      'have.length.greaterThan',
      20,
    );
    // Typing narrows the list.
    cy.get('[data-testid="theme-body-font"]').find('input').type('mono');
    cy.get('[data-testid="theme-body-font-dropdown"] [role="option"]').should(
      'have.length.lessThan',
      20,
    );
    cy.get('[data-testid="theme-body-font-dropdown"]').contains('Roboto Mono');
  });

  it('accepts a hand-typed family name that is not in the catalog', () => {
    cy.get('[data-testid="theme-body-font"]').find('input').type('SomeObscureCustomFont');
    // The text in the field becomes the bodyFont value, even though no
    // dropdown option matches.
    cy.get('[data-testid="theme-body-font-dropdown"]').contains('No matches');
    cy.get('[data-testid="theme-save"]').click();
    cy.wait('@saveSettings');
    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.theme.bodyFont).to.eq('SomeObscureCustomFont');
    });
  });
});
