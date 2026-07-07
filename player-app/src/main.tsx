import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installThemeInspect } from './theme-inspect';
import './index.css';

// when the player runs inside the editor's ThemeTab iframe
// (`?inspect=1`), expose click-to-edit + live theme updates from the
// parent. No-op on the public player.
installThemeInspect();

// Register the offline service worker. Skipped on file:// (no
// secure context — the SW spec rejects insecure origins) and on
// the editor preview iframe (no point caching a per-edit preview).
// On a hosted player the SW caches the app shell + provides the
// opt-in PRECACHE_AUDIO channel for "Download for offline".
if ('serviceWorker' in navigator && window.isSecureContext) {
  const isInsideEditor = new URLSearchParams(window.location.search).has('inspect');
  if (!isInsideEditor) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        // SW registration failure isn't fatal — the player keeps
        // working, just without offline caching. Log so a curious
        // dev can see it but don't surface to the user.
        console.warn('[wanderline] service worker registration failed', err);
      });
    });
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
