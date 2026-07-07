// Side-effect-only module: must be imported BEFORE any other backend
// imports so Sentry's auto-instrumentation can patch http/express/pg at
// load time. See `index.ts`.
import { initSentry } from './sentry.js';

initSentry();
