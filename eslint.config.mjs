// Flat ESLint config covering all workspaces. Per-area overrides handle
// the differences (Node globals for backend, browser globals + React for
// the two frontends, Jest/Vitest-compatible globals for tests).
//
// Named `.mjs` because the repo root package.json doesn't declare
// `"type": "module"` and we want this file parsed as ESM regardless.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.vite/**',
      'backend/migrations/**/*.sql',
      'cypress/screenshots/**',
      'cypress/videos/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide tweaks. We keep the rule set deliberately light — this PR
  // is about getting consistent formatting + a minimum quality bar, not
  // policing style. Tighten later if we hit a class of bugs lint could catch.
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Empty catches are commonly used for best-effort calls (localStorage
      // in private mode, optional cleanup, etc.). Empty *blocks* elsewhere
      // are still flagged.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Allow ternary statements (`cond ? a() : b()`) and short-circuit
      // (`cond && a()`) — common in React event handlers.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true },
      ],
      'no-console': 'off',
    },
  },

  // Module augmentation (declare global { namespace ... }) is the standard
  // way to extend Express.Request and Cypress.Chainable in TypeScript.
  {
    files: ['backend/src/middleware/auth.ts', 'cypress/support/commands.ts'],
    rules: { '@typescript-eslint/no-namespace': 'off' },
  },

  // Backend: Node runtime, no DOM globals.
  {
    files: ['backend/**/*.{ts,js}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Node-based build scripts under player-app (post-vite-build helpers).
  // The `player-app/**/*.{ts,tsx,js,jsx}` block below hands out browser
  // globals — correct for the React code, wrong for these scripts, which
  // run under Node at build time and use `process`, `console`, etc.
  // Matches .mjs so eslint stops flagging Node globals as no-undef.
  {
    files: ['player-app/scripts/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Frontend + player-app: React in the browser.
  {
    files: ['frontend/**/*.{ts,tsx,js,jsx}', 'player-app/**/*.{ts,tsx,js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      // Stick to the classic hooks rules. The newer rules from
      // eslint-plugin-react-hooks v7 (immutability, set-state-in-effect,
      // refs, etc.) are valuable but would need a real refactor of existing
      // working code; revisit in a follow-up.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },

  // Test files. Backend uses Jest, player-app uses Vitest, but Vitest
  // exposes Jest-compatible globals (`describe`, `it`, `expect`, etc.) and
  // the `globals` package only ships a `jest` set, so we reuse it for both.
  {
    files: ['backend/**/*.test.{ts,js}', 'backend/**/__tests__/**/*.{ts,js}'],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    files: ['player-app/**/*.test.{ts,tsx}', 'player-app/**/__tests__/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.jest } },
  },

  // Cypress files have their own globals. Chai assertions like
  // `expect(x).to.be.true` look like unused expressions to ESLint, so
  // disable that rule here.
  {
    files: ['cypress/**/*.{ts,js}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.mocha, cy: 'readonly', Cypress: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },

  // Plain Node scripts (deploy helpers, etc.).
  {
    files: ['scripts/**/*.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Disable any rules that conflict with Prettier formatting.
  prettier,
];
