describe('Story Upload', () => {
  const uniqueId = Date.now();
  const projectName = `Story Upload ${uniqueId}`;
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject(projectName).then((id) => {
      projectId = id;
    });
  });

  after(() => {
    cy.apiLogin();
    cy.apiDeleteProject(projectId);
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should show upload section in a new project', () => {
    cy.visit('/');
    cy.contains(projectName, { timeout: 15000 }).click();
    cy.contains('h1', projectName, { timeout: 15000 }).should('be.visible');
    // Story tab should show upload option
    cy.contains(/Upload|\.ink/i).should('be.visible');
  });

  it('should display story nodes after API upload', () => {
    cy.fixture('test-story.ink').then((content) => {
      cy.apiUploadInk(projectId, content);
    });

    cy.visit('/');
    cy.contains(projectName, { timeout: 15000 }).click();
    cy.contains('h1', projectName, { timeout: 15000 }).should('be.visible');

    // Story tab should show node names
    cy.contains('Story nodes', { timeout: 15000 }).should('be.visible');
  });

  it('should show story status via API after upload', () => {
    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.body.project.story_graph).to.not.be.null;
    });
  });
});
