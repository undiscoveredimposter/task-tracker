import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { watchSystemTheme } from './lib/theme';
import './index.css';

// A new build is picked up on the next launch rather than reloading under
// someone's finger mid-tick.
registerSW({ immediate: false });

// The boot script in index.html has already applied the stored theme. This only
// catches the operating system flipping while the app is open — CSS follows on
// its own, but the theme-color meta is out of its reach. Started here, outside
// React, so it survives navigation between screens.
watchSystemTheme(
  document,
  window.localStorage,
  window.matchMedia('(prefers-color-scheme: dark)'),
);

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
