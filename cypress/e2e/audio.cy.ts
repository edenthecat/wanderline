describe.skip('Audio Management', () => {
  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Audio Test').then((id) => {
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit('/');
    cy.contains('Audio Test').click();
  });

  it('should show the audio files section', () => {
    cy.contains('Audio Files').should('be.visible');
  });

  it('should show category dropdown for uploads', () => {
    cy.get('select').should('exist');
  });

  it('should show empty state when no audio uploaded', () => {
    cy.contains(/no audio/i).should('be.visible');
  });

  it('should show audio assignments section on expanded node', () => {
    cy.contains('button', 'List View').click();
    cy.contains('her').click();
    cy.contains('Voiceover').should('be.visible');
  });
});

describe.skip('Audio API', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Audio API Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should return empty audio list for new project', () => {
    cy.request('GET', `/api/projects/${projectId}/audio`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.audioFiles).to.be.an('array');
      expect(res.body.audioFiles).to.have.length(0);
    });
  });

  it('should return assignments for project', () => {
    cy.request('GET', `/api/projects/${projectId}/audio/assignments`).then((res) => {
      expect(res.status).to.eq(200);
    });
  });

  it('should return coverage for project', () => {
    cy.request('GET', `/api/projects/${projectId}/audio/coverage`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.coverage.withAudio).to.eq(0);
    });
  });
});
