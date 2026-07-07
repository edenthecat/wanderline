describe('Character Management', () => {
  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Characters Test').then((id) => {
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit('/');
    cy.contains('Characters Test', { timeout: 15000 }).click();
    cy.contains('h1', 'Characters Test', { timeout: 15000 }).should('be.visible');
    cy.contains('button', 'Characters').click();
  });

  it('should show the characters tab', () => {
    cy.contains('Characters').should('be.visible');
  });

  it('should create a new character', () => {
    cy.contains('button', 'New character').click();
    cy.get('input[placeholder="Character name"]').type('Anna');
    cy.contains('button', 'Create character').click();

    cy.contains('Anna').should('be.visible');
  });

  it('should create multiple characters', () => {
    cy.contains('button', 'New character').click();
    cy.get('input[placeholder="Character name"]').type('Narrator');
    cy.contains('button', 'Create character').click();

    cy.contains('Narrator').should('be.visible');
  });

  it('should delete a character via API', () => {
    cy.apiLogin();
    cy.request('GET', '/api/projects').then((res) => {
      const project = res.body.projects.find((p: { name: string }) => p.name === 'Characters Test');
      cy.request('POST', `/api/projects/${project.id}/characters`, {
        name: 'Temporary',
        theme: 'green',
      }).then((createRes) => {
        const charId = createRes.body.character.id;
        cy.request('DELETE', `/api/projects/${project.id}/characters/${charId}`).then(
          (deleteRes) => {
            expect(deleteRes.status).to.eq(200);
          },
        );
      });
    });
  });
});
