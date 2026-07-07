import { lintOpenApiSpec } from '../lint-openapi.js';
import { buildOpenApiSpec } from '../../openapi.js';

// spectral OpenAPI lint smoke. Runs the same lint the
// `npm run lint:openapi` CLI does, asserting our spec produces no
// errors. Warnings are allowed (operation-description, etc.) — only
// errors break the test, matching the CLI's exit-code contract.

describe('spectral OpenAPI lint', () => {
  it('produces zero errors against the live spec', async () => {
    const spec = buildOpenApiSpec();
    const result = await lintOpenApiSpec(spec);
    if (result.errors.length > 0) {
      // Format the failure so the test report shows exactly what
      // tripped — without this, jest just prints the count and a
      // future regression is annoying to diagnose.
      const lines = result.errors.map((e) => `  ✗ ${e.code}: ${e.message}  (${e.path})`);
      throw new Error(
        `OpenAPI spec failed lint with ${result.errors.length} error(s):\n${lines.join('\n')}`,
      );
    }
    expect(result.errors).toEqual([]);
  }, 30_000);
});
