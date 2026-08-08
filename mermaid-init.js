import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs';

const dark = document.documentElement.dataset.theme === 'dark';
mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
window.mermaid = mermaid;

// The main classic script runs before this module completes. Re-render a file
// opened during startup once Mermaid becomes available.
if (typeof window.renderMermaid === 'function') window.renderMermaid();
