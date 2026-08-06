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

// End-to-end sweep: every author-facing theming knob (globals, fonts +
// weights, customCss, per-component overrides, story-title fallback)
// PATCHed onto a project's settings and then verified in the served
// preview HTML. Backend unit tests prove each helper emits the right
// CSS variable in isolation; the tests here prove the whole pipeline
// (PATCH → merge → renderPreviewHtml → nonce'd <style>) survives at
// runtime, driven by the same route the theme editor and iframe use.
//
// The COMPONENT_KNOBS map below duplicates shared/src/theme-components.ts
// on purpose — Cypress's CommonJS tsconfig can't consume the ESM shared
// package cleanly. Keep them in sync when adding a new knob; a drift
// gets caught by the corresponding jest enumeration test failing.
describe('Theme editor — full-field e2e sweep', () => {
  let projectId: string;
  // Distinctive project name so we can also assert resolveStoryTitle
  // falls back to it (the fixture .ink doesn't set a StoryTitle).
  const PROJECT_NAME = 'Full Sweep Dear Anna';

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject(PROJECT_NAME).then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  // Global variables: mirror of VARIABLE_PROPERTY_MAP in
  // backend/src/services/theme-render.ts.
  const GLOBALS: Array<[string, string, string]> = [
    ['pageBackground', '--wl-page-bg', '#0a0a0a'],
    ['cardBackground', '--wl-card-bg', '#111111'],
    ['textColor', '--wl-text', '#eaeaea'],
    ['accentColor', '--wl-accent', '#4ecdc4'],
    ['headingColor', '--wl-heading', '#ffffff'],
    ['chromeColor', '--wl-chrome', '#909090'],
    ['iconColor', '--wl-icon-color', '#dddddd'],
  ];

  // Per-component keys: mirror of COMPONENT_SPECS in
  // shared/src/theme-components.ts. Keep in sync — a jest enumeration
  // test catches drift on the emit side.
  const COMPONENT_KNOBS: Record<string, string[]> = {
    page: ['background', 'backgroundImage', 'textColor', 'fontFamily', 'lineHeight'],
    header: [
      'background',
      'textColor',
      'fontFamily',
      'letterSpacing',
      'textTransform',
      'borderRadius',
      'padding',
      'borderColor',
    ],
    storyCard: [
      'background',
      'textColor',
      'borderRadius',
      'padding',
      'borderColor',
      'borderWidth',
      'borderStyle',
      'boxShadow',
      'lineHeight',
    ],
    choiceButton: [
      'background',
      'textColor',
      'hoverBackground',
      'borderColor',
      'borderWidth',
      'borderStyle',
      'borderRadius',
      'padding',
      'fontWeight',
      'letterSpacing',
      'textTransform',
      'boxShadow',
    ],
    instructionsCard: [
      'background',
      'textColor',
      'borderRadius',
      'padding',
      'borderColor',
      'borderWidth',
      'boxShadow',
    ],
    startButton: [
      'background',
      'hoverBackground',
      'textColor',
      'borderRadius',
      'padding',
      'fontWeight',
      'letterSpacing',
      'textTransform',
      'boxShadow',
    ],
    settingsPanel: [
      'background',
      'textColor',
      'borderRadius',
      'padding',
      'borderColor',
      'borderWidth',
      'boxShadow',
    ],
    resumePicker: [
      'background',
      'textColor',
      'borderColor',
      'borderWidth',
      'borderRadius',
      'padding',
      'boxShadow',
    ],
    errorBanner: [
      'background',
      'borderColor',
      'borderWidth',
      'borderRadius',
      'padding',
      'textColor',
    ],
  };

  it('applies every theming knob and the preview HTML reflects each one', () => {
    // Build the components override map. Distinct marker per knob so
    // the assertion loop finds them uniquely in the emitted CSS.
    const components: Record<string, Record<string, string>> = {};
    for (const [componentId, props] of Object.entries(COMPONENT_KNOBS)) {
      components[componentId] = Object.fromEntries(props.map((p) => [p, `E2E-${p}`]));
    }

    const theme = {
      variables: Object.fromEntries(GLOBALS.map(([field, , value]) => [field, value])),
      bodyFont: 'Inter',
      bodyFontWeights: ['300', '600'],
      headingFont: 'Playfair Display',
      headingFontWeights: ['700', '900'],
      customCss: '.wl-preview-banner { display: none; }',
      components,
    };

    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: { theme },
    })
      .its('status')
      .should('eq', 200);

    // Round-trip via GET first so we can confirm the merge kept every
    // field (JSONB merge bugs would surface here before the render).
    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      const stored = res.body.settings.theme;
      for (const [field, , value] of GLOBALS) {
        expect(stored.variables[field], `variables.${field} round-trip`).to.eq(value);
      }
      expect(stored.bodyFont).to.eq('Inter');
      expect(stored.bodyFontWeights).to.deep.eq(['300', '600']);
      expect(stored.headingFont).to.eq('Playfair Display');
      expect(stored.headingFontWeights).to.deep.eq(['700', '900']);
      expect(stored.customCss).to.contain('wl-preview-banner');
      for (const [componentId, props] of Object.entries(COMPONENT_KNOBS)) {
        for (const prop of props) {
          expect(
            stored.components[componentId][prop],
            `components.${componentId}.${prop} round-trip`,
          ).to.eq(`E2E-${prop}`);
        }
      }
    });

    // Ask the preview endpoint for the served HTML. This is exactly
    // what the editor iframe hits, and what the public-preview route
    // returns to shared visitors.
    cy.request(`/api/projects/${projectId}/preview`).then((res) => {
      const html = res.body as string;

      // Theme <style> block was injected with a CSP nonce.
      expect(html).to.match(/<style nonce="[^"]+" data-wanderline-theme>/);

      // Every global variable landed.
      for (const [, varName, value] of GLOBALS) {
        expect(html, `${varName} present`).to.contain(`${varName}: ${value};`);
      }

      // Font variables + Google Fonts <link> with weight params.
      expect(html).to.contain('--wl-font-body: Inter;');
      expect(html).to.contain("--wl-font-heading: 'Playfair Display';");
      expect(html).to.contain('--wl-font-body-weight: 300;');
      expect(html).to.contain('--wl-font-heading-weight: 700;');
      expect(html).to.contain('https://fonts.googleapis.com/css2?family=Inter:wght@300;600');
      expect(html).to.contain('family=Playfair+Display:wght@700;900');

      // customCss appended.
      expect(html).to.contain('.wl-preview-banner { display: none; }');

      // Every per-component override landed.
      for (const [componentId, props] of Object.entries(COMPONENT_KNOBS)) {
        for (const prop of props) {
          expect(html, `--wl-${componentId}-${prop} present`).to.contain(
            `--wl-${componentId}-${prop}: E2E-${prop};`,
          );
        }
      }

      // resolveStoryTitle fallback: the .ink fixture has no
      // StoryTitle, so the parser tags the graph title 'Untitled
      // Story' and the builder should swap in project.name before
      // handing off to the player.
      expect(html).to.contain(`"title":"${PROJECT_NAME}"`);
      expect(html).not.to.match(/"title":"Untitled Story"/);
    });
  });
});
