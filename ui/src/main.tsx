import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Check if running in Tauri by checking for Tauri API
const isTauri = () => {
  // @ts-ignore - Tauri global
  return typeof window !== 'undefined' && typeof window.__TAURI__ !== 'undefined';
};

async function main() {
  let App;
  
  if (isTauri()) {
    // Tauri mode - import the desktop app
    const module = await import('./App.tsx');
    App = module.default;
  } else {
    const webViewParam = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('view') : null;
    const isWebChat = typeof window !== 'undefined'
      ? webViewParam === 'web' || window.location.pathname.startsWith('/web')
      : false;
    if (isWebChat) {
      const module = await import('./WebApp.tsx');
      App = module.default;
    } else {
      const module = await import('./App.tsx');
      App = module.default;
    }
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main();
