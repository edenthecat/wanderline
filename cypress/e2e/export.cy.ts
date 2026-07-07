describe.skip('Export', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Export Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should show export buttons in project view', () => {
    cy.visit('/');
    cy.contains('Export Test').click();
    // Export buttons may be labeled differently
    cy.contains(/Export/i).should('be.visible');
  });

  it('should export project as JSON via API', () => {
    cy.request('GET', `/api/projects/${projectId}/export-json`).then((res) => {
      expect(res.status).to.eq(200);
    });
  });

  it('should export project as INK via API', () => {
    cy.request('GET', `/api/projects/${projectId}/export-ink`).then((res) => {
      expect(res.status).to.eq(200);
    });
  });

  it('should export wanderline archive via API', () => {
    cy.request({
      method: 'GET',
      url: `/api/projects/${projectId}/export`,
      encoding: 'binary',
    }).then((res) => {
      expect(res.status).to.eq(200);
    });
  });

  it('should generate script diff via API', () => {
    cy.request('GET', `/api/projects/${projectId}/script-diff?format=json`).then((res) => {
      expect(res.status).to.eq(200);
    });
  });

  it('should generate HTML script diff report via API', () => {
    cy.request('GET', `/api/projects/${projectId}/script-diff?format=html`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.headers['content-type']).to.include('text/html');
    });
  });
});
