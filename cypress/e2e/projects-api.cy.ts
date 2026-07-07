describe('Projects API', () => {
  before(() => {
    cy.setupAdmin();
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should create a project', () => {
    cy.request('POST', '/api/projects', {
      name: 'API Created Project',
      description: 'Created via API test',
    }).then((res) => {
      expect(res.status).to.eq(201);
      expect(res.body.project).to.have.property('id');
      expect(res.body.project.name).to.eq('API Created Project');
      expect(res.body.project.description).to.eq('Created via API test');
    });
  });

  it('should list projects', () => {
    cy.request('GET', '/api/projects').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.projects).to.be.an('array');
      expect(res.body.projects.length).to.be.greaterThan(0);
    });
  });

  it('should get a single project', () => {
    cy.request('POST', '/api/projects', {
      name: 'Get Single Project',
    }).then((createRes) => {
      const projectId = createRes.body.project.id;
      cy.request('GET', `/api/projects/${projectId}`).then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.project.name).to.eq('Get Single Project');
      });
    });
  });

  it('should update a project', () => {
    cy.request('POST', '/api/projects', {
      name: 'Update Me',
    }).then((createRes) => {
      const projectId = createRes.body.project.id;
      cy.request('PATCH', `/api/projects/${projectId}`, {
        name: 'Updated Name',
        description: 'Updated description',
      }).then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.project.name).to.eq('Updated Name');
        expect(res.body.project.description).to.eq('Updated description');
      });
    });
  });

  it('should delete a project', () => {
    cy.request('POST', '/api/projects', {
      name: 'Delete Me API',
    }).then((createRes) => {
      const projectId = createRes.body.project.id;
      cy.request('DELETE', `/api/projects/${projectId}`).then((res) => {
        expect(res.status).to.eq(200);
      });

      cy.request({
        method: 'GET',
        url: `/api/projects/${projectId}`,
        failOnStatusCode: false,
      }).then((res) => {
        expect(res.status).to.eq(404);
      });
    });
  });

  it('should reject creating project without name', () => {
    cy.request({
      method: 'POST',
      url: '/api/projects',
      body: { description: 'No name' },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(400);
    });
  });

  it('should reject access to non-existent project', () => {
    cy.request({
      method: 'GET',
      url: '/api/projects/00000000-0000-0000-0000-000000000000',
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(404);
    });
  });

  it('should upload ink source to a project', () => {
    cy.request('POST', '/api/projects', {
      name: 'Ink Upload API',
    }).then((createRes) => {
      const projectId = createRes.body.project.id;
      cy.fixture('test-story.ink').then((content) => {
        cy.request('POST', `/api/projects/${projectId}/ink`, { source: content }).then((res) => {
          expect(res.status).to.eq(200);
          expect(res.body.story).to.have.property('nodes');
          expect(res.body.story).to.have.property('startNode');
        });
      });
    });
  });

  it('should return story data when getting project with story', () => {
    cy.request('POST', '/api/projects', {
      name: 'Story Data API',
    }).then((createRes) => {
      const projectId = createRes.body.project.id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(projectId, content);

        cy.request('GET', `/api/projects/${projectId}`).then((res) => {
          expect(res.status).to.eq(200);
          expect(res.body.project.story_graph).to.have.property('nodes');
          expect(res.body.project.story_graph.nodes).to.have.property('her');
          expect(res.body.project.story_graph.nodes).to.have.property('credits');
        });
      });
    });
  });
});
