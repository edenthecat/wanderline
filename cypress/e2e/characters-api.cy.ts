describe('Characters API', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Characters API Test').then((id) => {
      projectId = id;
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should return empty character list', () => {
    cy.request('GET', `/api/projects/${projectId}/characters`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.characters).to.be.an('array');
      expect(res.body.characters).to.have.length(0);
    });
  });

  it('should create a character', () => {
    cy.request('POST', `/api/projects/${projectId}/characters`, {
      name: 'Anna',
      theme: 'blue',
    }).then((res) => {
      expect(res.status).to.eq(201);
      expect(res.body.character.name).to.eq('Anna');
      expect(res.body.character.theme).to.eq('blue');
      expect(res.body.character).to.have.property('id');
      expect(res.body.character).to.have.property('color');
    });
  });

  it('should create a character with a different theme', () => {
    cy.request('POST', `/api/projects/${projectId}/characters`, {
      name: 'Narrator',
      theme: 'purple',
    }).then((res) => {
      expect(res.status).to.eq(201);
      expect(res.body.character.name).to.eq('Narrator');
      expect(res.body.character.theme).to.eq('purple');
    });
  });

  it('should list all characters', () => {
    cy.request('GET', `/api/projects/${projectId}/characters`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.characters).to.have.length(2);
      const names = res.body.characters.map((c: { name: string }) => c.name);
      expect(names).to.include('Anna');
      expect(names).to.include('Narrator');
    });
  });

  it('should update a character', () => {
    cy.request('GET', `/api/projects/${projectId}/characters`).then((res) => {
      const anna = res.body.characters.find((c: { name: string }) => c.name === 'Anna');
      cy.request('PATCH', `/api/projects/${projectId}/characters/${anna.id}`, {
        name: 'Anna Marie',
        theme: 'red',
      }).then((updateRes) => {
        expect(updateRes.status).to.eq(200);
        expect(updateRes.body.character.name).to.eq('Anna Marie');
        expect(updateRes.body.character.theme).to.eq('red');
      });
    });
  });

  it('should delete a character', () => {
    cy.request('GET', `/api/projects/${projectId}/characters`).then((res) => {
      const narrator = res.body.characters.find((c: { name: string }) => c.name === 'Narrator');
      cy.request('DELETE', `/api/projects/${projectId}/characters/${narrator.id}`).then(
        (deleteRes) => {
          expect(deleteRes.status).to.eq(200);
        },
      );
    });

    cy.request('GET', `/api/projects/${projectId}/characters`).then((res) => {
      expect(res.body.characters).to.have.length(1);
    });
  });

  it('should prevent duplicate character names in same project', () => {
    cy.request({
      method: 'POST',
      url: `/api/projects/${projectId}/characters`,
      body: {
        name: 'Anna Marie',
        theme: 'green',
      },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(400);
    });
  });
});
