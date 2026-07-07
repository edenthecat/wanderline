import { StoryDataError } from '../story-data-builder.js';

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
