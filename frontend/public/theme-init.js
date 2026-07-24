// Apply the saved theme before first paint to avoid a flash.
// External file (not inline) so the strict script-src 'self' CSP allows it.
if (localStorage.getItem('lemniscate-theme') === 'light') {
  document.documentElement.classList.remove('dark');
}
