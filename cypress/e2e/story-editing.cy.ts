describe('Story Editing via API', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Story Edit Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should get the story graph', () => {
    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.project.story_graph).to.have.property('nodes');
      expect(res.body.project.story_graph).to.have.property('startNode');
    });
  });

  it('should update a choice target', () => {
    cy.request('PATCH', `/api/projects/${projectId}/story/choice`, {
      nodeId: 'her',
      choiceIndex: 0,
      newTarget: 'credits',
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      const herNode = res.body.project.story_graph.nodes['her'];
      expect(herNode.choices[0].target).to.eq('credits');
    });

    // Revert
    cy.request('PATCH', `/api/projects/${projectId}/story/choice`, {
      nodeId: 'her',
      choiceIndex: 0,
      newTarget: 'END',
    });
  });

  it('should update a choice text', () => {
    cy.request('PATCH', `/api/projects/${projectId}/story/choice/text`, {
      nodeId: 'her',
      choiceIndex: 0,
      newText: 'EARLIER',
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      const herNode = res.body.project.story_graph.nodes['her'];
      expect(herNode.choices[0].text).to.eq('EARLIER');
    });

    // Revert
    cy.request('PATCH', `/api/projects/${projectId}/story/choice/text`, {
      nodeId: 'her',
      choiceIndex: 0,
      newText: 'BEFORE',
    });
  });

  it('should update a divert target', () => {
    cy.request('PATCH', `/api/projects/${projectId}/story/divert`, {
      nodeId: 'marked_for_tragedy',
      newTarget: 'her',
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.body.project.story_graph.nodes['marked_for_tragedy'].divert).to.eq('her');
    });

    // Revert
    cy.request('PATCH', `/api/projects/${projectId}/story/divert`, {
      nodeId: 'marked_for_tragedy',
      newTarget: 'credits',
    });
  });

  it('should swap choice order', () => {
    cy.request('PATCH', `/api/projects/${projectId}/story/choice/swap`, {
      nodeId: 'her',
      fromIndex: 0,
      toIndex: 1,
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      const herNode = res.body.project.story_graph.nodes['her'];
      expect(herNode.choices[0].text).to.eq('AFTER');
      expect(herNode.choices[1].text).to.eq('BEFORE');
    });

    // Swap back
    cy.request('PATCH', `/api/projects/${projectId}/story/choice/swap`, {
      nodeId: 'her',
      fromIndex: 0,
      toIndex: 1,
    });
  });

  it('should remove and restore a choice', () => {
    cy.request('DELETE', `/api/projects/${projectId}/story/choice`, {
      nodeId: 'her',
      choiceIndex: 1,
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.body.project.story_graph.nodes['her'].choices).to.have.length(1);
    });

    // Restore
    cy.request('POST', `/api/projects/${projectId}/story/choice`, {
      nodeId: 'her',
      choice: { text: 'AFTER', target: 'tell_you' },
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.body.project.story_graph.nodes['her'].choices).to.have.length(2);
    });
  });
});
