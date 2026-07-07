describe('Project Management', () => {
  before(() => {
    cy.setupAdmin();
  });

  beforeEach(() => {
    cy.apiLogin();
    cy.visit('/');
    cy.contains('Projects', { timeout: 15000 }).should('be.visible');
  });

  it('should show the projects page with create button', () => {
    cy.contains('h1', 'Projects').should('be.visible');
    cy.contains('button', 'New project').should('be.visible');
  });

  it('should open create project form', () => {
    cy.contains('button', 'New project').click();
    cy.contains('Project name').should('be.visible');
  });

  it('should cancel project creation', () => {
    cy.contains('button', 'New project').click();
    cy.get('input[placeholder="My Story Project"]').type('Cancelled Project');
    cy.contains('button', 'Cancel').click();

    cy.contains('Cancelled Project').should('not.exist');
  });

  it('should create a new project', () => {
    cy.contains('button', 'New project').click();
    cy.get('input[placeholder="My Story Project"]').type('E2E Test Project');
    cy.get('input[placeholder="A brief description"]').type('Created by Cypress');
    cy.contains('button', 'Create project').click();

    // Project should appear in the list
    cy.contains('E2E Test Project', { timeout: 15000 }).should('be.visible');
  });

  it('should show the project in the dashboard list', () => {
    cy.apiCreateProject('Listed Project', 'Should appear in list');
    cy.visit('/');

    cy.contains('Listed Project').should('be.visible');
    cy.contains('Should appear in list').should('be.visible');
  });

  it('should navigate to a project when clicked', () => {
    cy.apiCreateProject('Clickable Project').then(() => {
      cy.visit('/');
      cy.contains('Clickable Project').click();
      cy.contains('h1', 'Clickable Project', { timeout: 15000 }).should('be.visible');
    });
  });

  it('should show no story badge for new project', () => {
    cy.apiCreateProject('No Story Project');
    cy.visit('/');

    cy.contains('No Story Project').should('be.visible');
    cy.contains('No story').should('be.visible');
  });
});
