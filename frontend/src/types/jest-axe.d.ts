// Local types for `jest-axe`.
//
// The package ships no declarations of its own, and the DefinitelyTyped
// `@types/jest-axe` depends on `@types/jest` — which would put Jest's
// globals into a workspace that runs on vitest, where they clash. Only
// two exports are used, so they are declared here instead.

declare module 'jest-axe' {
  import type { AxeResults, RunOptions } from 'axe-core';

  export function axe(html: Element | string, options?: RunOptions): Promise<AxeResults>;

  export const toHaveNoViolations: {
    toHaveNoViolations(results: AxeResults): {
      pass: boolean;
      actual: unknown;
      message(): string;
    };
  };

  export function configureAxe(options?: RunOptions): typeof axe;
}
