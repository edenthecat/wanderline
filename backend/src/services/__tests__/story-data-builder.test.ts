import { StoryDataError, resolveStoryTitle } from '../story-data-builder.js';

describe('StoryDataError', () => {
  it('should create error with message and status code', () => {
    const error = new StoryDataError('Not found', 404);
    expect(error.message).toBe('Not found');
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('StoryDataError');
  });

  it('should be an instance of Error', () => {
    const error = new StoryDataError('Bad request', 400);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StoryDataError);
  });

  it('should work with try/catch', () => {
    try {
      throw new StoryDataError('Project has no story', 400);
    } catch (e) {
      expect(e).toBeInstanceOf(StoryDataError);
      if (e instanceof StoryDataError) {
        expect(e.statusCode).toBe(400);
        expect(e.message).toBe('Project has no story');
      }
    }
  });
});

describe('resolveStoryTitle', () => {
  it("returns the story-graph title when it doesn't look like a parser default", () => {
    expect(resolveStoryTitle('Dear Anna', 'Wanderline Project')).toBe('Dear Anna');
  });

  it('falls back to the project name when the graph title is "Untitled"', () => {
    // The Twee parser sets `title: 'Untitled'` when no StoryTitle
    // passage is present. Everyone would rather see the project name
    // in that case.
    expect(resolveStoryTitle('Untitled', 'Dear Anna')).toBe('Dear Anna');
  });

  it('falls back to the project name when the graph title is "Untitled Story"', () => {
    // The Ink parser uses a different literal.
    expect(resolveStoryTitle('Untitled Story', 'My Project')).toBe('My Project');
  });

  it('falls back to the project name when the graph title is empty', () => {
    expect(resolveStoryTitle('', 'Backup Name')).toBe('Backup Name');
  });

  it('trims whitespace from the fallback project name', () => {
    expect(resolveStoryTitle('Untitled', '   Trimmed   ')).toBe('Trimmed');
  });

  it('keeps the parser-default title when the project name is unusable', () => {
    // If the project name is missing / blank we can't do better than
    // "Untitled"; return whatever the graph had rather than an empty
    // string so the player's `<h1>` still has content.
    expect(resolveStoryTitle('Untitled', '')).toBe('Untitled');
    expect(resolveStoryTitle('Untitled', '   ')).toBe('Untitled');
    expect(resolveStoryTitle('Untitled Story', null as unknown as string)).toBe('Untitled Story');
  });

  it('coerces non-string inputs to reasonable defaults', () => {
    expect(resolveStoryTitle(null, 'Backup')).toBe('Backup');
    expect(resolveStoryTitle(undefined, 'Backup')).toBe('Backup');
    expect(resolveStoryTitle(42, 'Backup')).toBe('Backup');
  });
});
