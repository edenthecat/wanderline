describe('Node Metadata', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Metadata Test').then((id) => {
      projectId = id;
      cy.fixture('test-story.ink').then((content) => {
        cy.apiUploadInk(id, content);
      });
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should return metadata for project', () => {
    cy.request('GET', `/api/projects/${projectId}/metadata`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property('metadata');
    });
  });

  it('should set transcript for a node', () => {
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      transcript: 'This is a test transcript for the her node.',
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/metadata/her`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.metadata.transcript).to.eq('This is a test transcript for the her node.');
    });
  });

  it('should set auto-advance for a node', () => {
    cy.request('PUT', `/api/projects/${projectId}/metadata/marked_for_tragedy`, {
      autoAdvance: true,
      autoAdvanceDelayMs: 2000,
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/metadata/marked_for_tragedy`).then((res) => {
      expect(res.body.metadata.autoAdvance).to.eq(true);
      expect(res.body.metadata.autoAdvanceDelayMs).to.eq(2000);
    });
  });

  it('should set delay timing for a node', () => {
    cy.request('PUT', `/api/projects/${projectId}/metadata/tell_you`, {
      delayBeforeMs: 500,
      delayAfterMs: 1000,
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/metadata/tell_you`).then((res) => {
      expect(res.body.metadata.delayBeforeMs).to.eq(500);
      expect(res.body.metadata.delayAfterMs).to.eq(1000);
    });
  });

  it('should set choice timing for a node', () => {
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      choice1TimestampMs: 3000,
      choice2TimestampMs: 5000,
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/metadata/her`).then((res) => {
      expect(res.body.metadata.choice1TimestampMs).to.eq(3000);
      expect(res.body.metadata.choice2TimestampMs).to.eq(5000);
    });
  });

  it('should update existing metadata', () => {
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      transcript: 'Updated transcript.',
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/metadata/her`).then((res) => {
      expect(res.body.metadata.transcript).to.eq('Updated transcript.');
    });
  });

  it('clears a saved transcript when PUT receives an empty string', () => {
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      transcript: 'Will be cleared.',
    });
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      transcript: '',
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.metadata.transcript).to.eq('');
    });
  });

  it('also clears a saved transcript when PUT receives null', () => {
    // Backend normalizes `null` to '' so the typed-API path
    // (NodeMetadata.transcript = string | null) works without a
    // dedicated DELETE endpoint.
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      transcript: 'Will be cleared via null.',
    });
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      transcript: null,
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.metadata.transcript).to.eq('');
    });
  });

  it('preserves unrelated fields when only transcript is sent', () => {
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      delayBeforeMs: 500,
      autoAdvance: false,
      autoAdvanceDelayMs: 1500,
    });
    cy.request('PUT', `/api/projects/${projectId}/metadata/her`, {
      transcript: 'Just a transcript edit.',
    });
    cy.request('GET', `/api/projects/${projectId}/metadata/her`).then((res) => {
      expect(res.body.metadata.transcript).to.eq('Just a transcript edit.');
      expect(res.body.metadata.delayBeforeMs).to.eq(500);
      expect(res.body.metadata.autoAdvance).to.eq(false);
      expect(res.body.metadata.autoAdvanceDelayMs).to.eq(1500);
    });
  });

  it('should delete metadata for a node', () => {
    cy.request('DELETE', `/api/projects/${projectId}/metadata/tell_you`).then((res) => {
      expect(res.status).to.eq(200);
    });
  });

  it('should return metadata map with set nodes', () => {
    cy.request('GET', `/api/projects/${projectId}/metadata`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.metadata).to.have.property('her');
      expect(res.body.metadata).to.have.property('marked_for_tragedy');
    });
  });
});
