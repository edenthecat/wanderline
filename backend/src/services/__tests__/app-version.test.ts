// tests for the running-version report. The resolver takes its reader,
// env and cwd as arguments precisely so the fallback chain can be
// exercised without a filesystem.

import { resolveAppVersion } from '../app-version.js';

const reader = (files: Record<string, string>) => (path: string) => {
  if (!(path in files)) throw new Error(`ENOENT: ${path}`);
  return files[path];
};

describe('resolveAppVersion', () => {
  // Production layout: WORKDIR /app, `node backend/dist/index.js`.
  it('reads backend/package.json from the prod layout', () => {
    const out = resolveAppVersion(
      reader({ '/app/backend/package.json': JSON.stringify({ version: '1.4.0' }) }),
      {},
      '/app',
    );
    expect(out.version).toBe('1.4.0');
  });

  // Dev layout: docker-compose mounts ./backend at /app, so the
  // package.json is at the root of the working directory.
  it('falls back to ./package.json for the dev layout', () => {
    const out = resolveAppVersion(
      reader({ '/app/package.json': JSON.stringify({ version: '1.4.0-dev' }) }),
      {},
      '/app',
    );
    expect(out.version).toBe('1.4.0-dev');
  });

  it('prefers backend/package.json when both exist', () => {
    const out = resolveAppVersion(
      reader({
        '/app/backend/package.json': JSON.stringify({ version: '1.4.0' }),
        '/app/package.json': JSON.stringify({ version: '9.9.9' }),
      }),
      {},
      '/app',
    );
    expect(out.version).toBe('1.4.0');
  });

  // A package.json with no version string is more likely the wrong
  // file than a package we should report `undefined` for.
  it('skips a package.json with no usable version', () => {
    const out = resolveAppVersion(
      reader({
        '/app/backend/package.json': JSON.stringify({ name: 'no-version-here' }),
        '/app/package.json': JSON.stringify({ version: '1.4.0' }),
      }),
      {},
      '/app',
    );
    expect(out.version).toBe('1.4.0');
  });

  it.each([
    ['unreadable', {}],
    ['malformed', { '/app/backend/package.json': 'not json{' }],
  ])('reports unknown rather than throwing when %s', (_label, files) => {
    const out = resolveAppVersion(reader(files as Record<string, string>), {}, '/app');
    expect(out.version).toBe('unknown');
  });

  // deploy-backend.sh sets SENTRY_RELEASE to the deployed short SHA.
  it('reports the deployed commit from SENTRY_RELEASE', () => {
    const out = resolveAppVersion(reader({}), { SENTRY_RELEASE: '4b8fd0c' }, '/app');
    expect(out.commit).toBe('4b8fd0c');
  });

  it.each([undefined, '', '   '])('reports a null commit for %p', (SENTRY_RELEASE) => {
    const out = resolveAppVersion(reader({}), { SENTRY_RELEASE }, '/app');
    expect(out.commit).toBeNull();
  });

  it('defaults environment to development', () => {
    expect(resolveAppVersion(reader({}), {}, '/app').environment).toBe('development');
    expect(resolveAppVersion(reader({}), { NODE_ENV: 'production' }, '/app').environment).toBe(
      'production',
    );
  });
});
