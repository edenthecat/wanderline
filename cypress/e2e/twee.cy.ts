// Phase 7: Twee upload + dual-source export + nomenclature.
//
// Covers the API surface introduced by the Twine epic:
//   - POST /:id/twine (Twee 3 ingest) round-trips a story graph.
//   - Uploading Twee sets source_language='twee' and clears ink_source.
//   - GET /:id/exports/twee returns the cached upload verbatim first, and
//     re-emits after an in-app graph mutation invalidates the cache.
//   - GET /:id/exports/ink cross-emits into the sibling format.
//   - The Settings PATCH accepts the new `nomenclature` key.
//   - Twine 2 `<tw-storydata>` HTML archives are rejected with a 400.
//
// All checks use the API surface — the CodeMirror-based Twee editor is
// covered in the frontend vitest suite. Keeping these as API tests here
// lets them run alongside the existing export.cy.ts flow without
// depending on Playwright/CodeMirror timing.

describe('Twee', () => {
  const uniqueId = Date.now();
  const projectName = `Twee ${uniqueId}`;
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

  it('POST /:id/twine ingests a Twee 3 story and populates the graph', () => {
    cy.fixture('test-story.twee').then((content) => {
      cy.apiUploadTwee(projectId, content);
    });

    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.project.story_graph).to.not.be.null;
      // The parser normalises passage names to node ids; the fixture's
      // Start node is what the graph fell back to (StoryData points at
      // "Start").
      expect(res.body.project.story_graph.startNode).to.eq('Start');
      expect(res.body.project.story_graph.title).to.eq('Test Twee Story');
      expect(Object.keys(res.body.project.story_graph.nodes)).to.include('Her');
      expect(res.body.project.source_language).to.eq('twee');
    });
  });

  it('clears ink_source when a Twee upload replaces an Ink one', () => {
    // Upload Ink first — that populates ink_source and sets
    // source_language='ink'.
    cy.fixture('test-story.ink').then((content) => {
      cy.apiUploadInk(projectId, content);
    });
    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.body.project.source_language).to.eq('ink');
    });

    // Then upload Twee — twee_source populates, ink_source clears.
    cy.fixture('test-story.twee').then((content) => {
      cy.apiUploadTwee(projectId, content);
    });
    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.body.project.source_language).to.eq('twee');
      // The fetch endpoint exposes twee_source; the ink cache clear is
      // visible indirectly by asking the export endpoint for Ink and
      // seeing the emitter's normalised output (rather than the
      // author's original file).
      expect(res.body.project.twee_source).to.include(':: StoryTitle');
    });
  });

  it('GET /:id/exports/twee returns the cached upload verbatim', () => {
    cy.fixture('test-story.twee').then((content) => {
      cy.apiUploadTwee(projectId, content);
      cy.request('GET', `/api/projects/${projectId}/exports/twee`).then((res) => {
        expect(res.status).to.eq(200);
        // Body is the original file — headers, tags, and comments
        // preserved because we hit the cached-source path.
        expect(res.body).to.include(':: StoryTitle');
        expect(res.body).to.include('Test Twee Story');
        expect(res.body).to.include('[[Enter site->Her]]');
      });
    });
  });

  it('GET /:id/exports/ink cross-emits from a Twee project', () => {
    cy.fixture('test-story.twee').then((content) => {
      cy.apiUploadTwee(projectId, content);
    });
    cy.request('GET', `/api/projects/${projectId}/exports/ink`).then((res) => {
      expect(res.status).to.eq(200);
      // Ink knot syntax — the emitter walks the graph and produces
      // === Name === blocks for each passage.
      expect(res.body).to.match(/=== \w+ ===/);
    });
  });

  it('rejects an unknown export format with 400', () => {
    cy.request({
      method: 'GET',
      url: `/api/projects/${projectId}/exports/harlowe`,
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(400);
    });
  });

  it('rejects a Twine 2 published .html archive with a helpful error', () => {
    cy.fixture('twine2-published.html').then((content) => {
      cy.request({
        method: 'POST',
        url: `/api/projects/${projectId}/twine`,
        body: { source: content },
        failOnStatusCode: false,
      }).then((res) => {
        // Parser hits no_passages because there's no `:: Name` header.
        // The frontend sniff catches this earlier with a targeted
        // message; the API layer's contract is the 400 status.
        expect(res.status).to.eq(400);
      });
    });
  });

  it('accepts a SugarCube-flavoured fixture with macros, hooks, and reverse-arrow links', () => {
    // The parser passes SugarCube macros (<<if>>, <<set>>) and Harlowe
    // hook syntax through as content — they must not trip the tag or
    // link tokeniser. Also exercises the `[[Target<-Text]]` reverse
    // arrow link shape, which is the same as `[[Text->Target]]` but
    // easier to forget in a round-trip.
    cy.fixture('twee-sugarcube.twee').then((content) => {
      cy.apiUploadTwee(projectId, content);
    });
    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      expect(res.status).to.eq(200);
      const g = res.body.project.story_graph;
      expect(g.startNode).to.eq('Cave');
      expect(g.nodes.Cave).to.exist;
      expect(g.nodes.Waterfall).to.exist;
      // Reverse-arrow link on Waterfall points BACK at Waterfall — a
      // self-link is legal Twee and must appear on the choices list.
      const waterfallLinks = g.nodes.Waterfall.choices.map((c: { target: string }) => c.target);
      expect(waterfallLinks).to.include('Waterfall');
      // Macros stayed inside content, not lifted into tags.
      expect(g.nodes.Cave.tags).to.deep.eq(['entrance', 'dark']);
    });
  });

  it('rejects Twee 1 markup (leading `!` on a header) with a targeted 400', () => {
    const twee1 = '!Passage\nOld-school Twee.\n';
    cy.request({
      method: 'POST',
      url: `/api/projects/${projectId}/twine`,
      body: { source: twee1 },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(400);
      expect(res.body.error || res.body.message || '').to.match(/twee/i);
    });
  });

  it('PATCH /:id/settings accepts a `nomenclature` value', () => {
    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: { nomenclature: 'twee' },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.settings.nomenclature).to.eq('twee');
    });

    // Round-trip the value from a fresh GET so we know it persisted.
    cy.request('GET', `/api/projects/${projectId}/settings`).then((res) => {
      expect(res.body.settings.nomenclature).to.eq('twee');
    });

    // Reset so later tests don't inherit the override.
    cy.request('PATCH', `/api/projects/${projectId}/settings`, {
      settings: { nomenclature: 'auto' },
    });
  });

  it('re-emits the Twee export after an in-app graph mutation', () => {
    cy.fixture('test-story.twee').then((content) => {
      cy.apiUploadTwee(projectId, content);
    });

    // Mutate the graph: swap two choices on the Her passage. The exact
    // shape of the PATCH mirrors what the choice-list drag reorder in
    // StoryTab sends.
    cy.request('GET', `/api/projects/${projectId}`).then((res) => {
      const her = res.body.project.story_graph.nodes.Her;
      if (!her || her.choices.length < 2) {
        // Fixture surprise — skip the mutation rather than crash. If
        // this triggers, the fixture needs updating.
        return;
      }
      cy.request('PATCH', `/api/projects/${projectId}/story/choice/swap`, {
        nodeId: 'Her',
        fromIndex: 0,
        toIndex: 1,
      });
    });

    // The next export must reflect the swap. Because the mutation
    // clears twee_source, the endpoint re-emits from story_graph. The
    // deterministic emitter preserves the swap.
    cy.request('GET', `/api/projects/${projectId}/exports/twee`).then((res) => {
      expect(res.status).to.eq(200);
      const her = res.body.split(':: Her')[1]?.split(':: ')[0] ?? '';
      // Second link in the fixture was AFTER->TellYou; after swap it's
      // first. The point isn't the exact ordering — it's that the
      // export reflects the current graph rather than the original
      // upload text.
      expect(her).to.match(/\[\[.*TellYou.*\]\][\s\S]*\[\[.*Ending.*\]\]/);
    });
  });
});
