// GET /api/projects/:id/validate — cheap pre-build validation
// surfacing story-parser errors, missing audio assignments, and
// orphaned files in one JSON report.

describe('Project validation endpoint', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Validate Test').then((id) => {
      projectId = id;
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('reports no errors for a project with no story', () => {
    cy.request('GET', `/api/projects/${projectId}/validate`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.report.hasStory).to.eq(false);
      expect(res.body.report.summary.nodeCount).to.eq(0);
      expect(res.body.report.summary.errorCount).to.eq(0);
    });
  });

  it('reports node + audio counts once a story is uploaded', () => {
    cy.fixture('test-story.ink').then((content) => {
      cy.apiUploadInk(projectId, content);
    });
    cy.request('GET', `/api/projects/${projectId}/validate`).then((res) => {
      expect(res.body.report.hasStory).to.eq(true);
      expect(res.body.report.summary.nodeCount).to.be.greaterThan(0);
      // Fresh project has no audio, so no missing or orphaned entries.
      expect(res.body.report.summary.missingAudioCount).to.eq(0);
      expect(res.body.report.summary.orphanedAudioCount).to.eq(0);
    });
  });

  it('exposes the story validation errors / warnings in the same payload', () => {
    cy.request('GET', `/api/projects/${projectId}/validate`).then((res) => {
      const { storyIssues } = res.body.report;
      expect(storyIssues).to.have.property('errors');
      expect(storyIssues).to.have.property('warnings');
      expect(Array.isArray(storyIssues.errors)).to.eq(true);
      expect(Array.isArray(storyIssues.warnings)).to.eq(true);
    });
  });

  it('404s when the project does not exist', () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    cy.request({
      method: 'GET',
      url: `/api/projects/${fakeId}/validate`,
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(404);
    });
  });
});
