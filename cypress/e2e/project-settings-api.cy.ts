describe('Project Settings API', () => {
  let projectId: string;

  before(() => {
    cy.setupAdmin();
    cy.apiLogin();
    cy.apiCreateProject('Settings API Test').then((id) => {
      projectId = id;
    });
  });

  beforeEach(() => {
    cy.apiLogin();
  });

  it('should get default settings', () => {
    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property('settings');
    });
  });

  it('should update bluetooth controls', () => {
    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: {
        bluetoothControls: {
          enabled: true,
          playPauseAction: 'play_pause',
          nextAction: 'next_choice',
          previousAction: 'previous_choice',
          seekForwardAction: 'confirm_choice',
          seekBackwardAction: 'go_back',
        },
      },
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.bluetoothControls.enabled).to.eq(true);
      expect(res.body.settings.bluetoothControls.nextAction).to.eq('next_choice');
    });
  });

  it('should update background music settings', () => {
    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: {
        backgroundMusicEnabled: true,
        backgroundMusicVolume: 50,
      },
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.backgroundMusicEnabled).to.eq(true);
      expect(res.body.settings.backgroundMusicVolume).to.eq(50);
    });
  });

  it('should update indicator volume', () => {
    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: {
        indicatorVolume: 75,
      },
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.indicatorVolume).to.eq(75);
    });
  });

  it('should set password protection', () => {
    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: {
        password: 'mypassword',
      },
    }).then((res) => {
      expect(res.status).to.eq(200);
    });

    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.password).to.eq('mypassword');
    });
  });

  it('should merge settings without overwriting existing', () => {
    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: { backgroundMusicVolume: 30 },
    });

    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: { indicatorVolume: 100 },
    });

    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.backgroundMusicVolume).to.eq(30);
      expect(res.body.settings.indicatorVolume).to.eq(100);
    });
  });
});
