#!/usr/bin/env -S node --experimental-strip-types
/* eslint-disable @typescript-eslint/no-explicit-any */

// programmatic OpenAPI lint via Spectral.
//
// The openapi.test.ts smoke covers presence + shape; this enforces
// per-operation hygiene: every op has a summary, every $ref resolves,
// path parameters are declared, response schemas use the shared
// components, and so on. Catches typos that swagger-jsdoc otherwise
// quietly compiles into a slightly-wrong spec.
//
// Wired to:
//   - `npm run lint:openapi` for local use
//   - openapi-lint.test.ts as a jest case so CI catches regressions
//     alongside everything else
//
// Loose rules (downgraded to off) live in DISABLED_RULES below — the
// stoplight OAS ruleset is opinionated and not every rule fits a
// session-auth, admin-facing internal API.

// Spectral packages are published as CJS; tsx + Node import-resolution
// surfaces their value-side exports off the default export. Use the
// namespace import so the call sites read normally.
import spectralCore from '@stoplight/spectral-core';
import spectralRulesets from '@stoplight/spectral-rulesets';
import spectralParsers from '@stoplight/spectral-parsers';
import { buildOpenApiSpec } from '../openapi.js';

const { Spectral, Document } = spectralCore;
const { oas } = spectralRulesets;
const Parsers = spectralParsers;

// Rules disabled for this codebase:
//   info-contact: internal API, no public contact
//   info-license: no license metadata required for an internal repo
//   info-description: title + description live in the spec already
//   contact-properties / license-url: as above
//   oas3-api-servers: we set a relative `/api` server which spectral
//     considers invalid; the swagger-ui still renders it correctly
//   operation-tag-defined: we use inline tag arrays, no global tags[]
//   operation-operationId: optional in OAS 3; we omit by design
const DISABLED_RULES = new Set([
  'info-contact',
  'info-license',
  'info-description',
  'contact-properties',
  'license-url',
  'oas3-api-servers',
  'operation-tag-defined',
  'operation-operationId',
]);

export interface LintIssue {
  code: string;
  message: string;
  path: string;
  severity: number; // 0 = error, 1 = warn, 2 = info, 3 = hint
}

export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
}

function buildSpectral(): InstanceType<typeof Spectral> {
  const s = new Spectral();
  // Spectral types `oas.rules` as a tight const map. To downgrade
  // selected rules to off without enumerating ~60 names we mutate a
  // shallow copy via `any` — the runtime shape just needs `severity`
  // set to 'off' on each disabled rule.

  const rules: any = { ...oas.rules };
  for (const code of DISABLED_RULES) {
    if (rules[code]) {
      rules[code] = { ...rules[code], severity: 'off' };
    }
  }
  s.setRuleset({ ...oas, rules });
  return s;
}

export async function lintOpenApiSpec(spec: object): Promise<LintResult> {
  const spectral = buildSpectral();
  const doc = new Document(JSON.stringify(spec), Parsers.Json, 'openapi.json');
  const findings = await spectral.run(doc);
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  for (const f of findings) {
    const issue: LintIssue = {
      code: String(f.code),
      message: f.message,
      path: f.path.join('.'),
      severity: f.severity,
    };
    if (f.severity === 0) errors.push(issue);
    else if (f.severity === 1) warnings.push(issue);
  }
  return { errors, warnings };
}

async function main(argv: string[]): Promise<number> {
  const quiet = argv.includes('--quiet');
  const spec = buildOpenApiSpec();
  const { errors, warnings } = await lintOpenApiSpec(spec);

  if (!quiet) {
    for (const w of warnings) {
      process.stdout.write(`  ⚠ ${w.code}: ${w.message}  (${w.path})\n`);
    }
    for (const e of errors) {
      process.stdout.write(`  ✗ ${e.code}: ${e.message}  (${e.path})\n`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(
      `lint:openapi: ${errors.length} error(s), ${warnings.length} warning(s)\n`,
    );
    return 1;
  }
  process.stdout.write(`lint:openapi: 0 errors, ${warnings.length} warnings (ok)\n`);
  return 0;
}

const argv1 = process.argv[1] ?? '';
const isCli = argv1.endsWith('lint-openapi.ts') || argv1.endsWith('lint-openapi.js');
if (isCli) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`lint:openapi: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
