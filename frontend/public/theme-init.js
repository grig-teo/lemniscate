// Apply the saved theme before first paint to avoid a flash.
// External file (not inline) so the strict script-src 'self' CSP allows it.
//
// Preference is one of 'light' | 'dark' | 'system' (or absent = 'system').
// 'system' resolves from the OS `prefers-color-scheme` media query so the
// first paint always matches the user's OS appearance.
(function () {
  var pref = localStorage.getItem('lemniscate-theme');
  var dark;
  if (pref === 'light') {
    dark = false;
  } else if (pref === 'dark') {
    dark = true;
  } else {
    // 'system' or unset: follow the OS preference, defaulting to light.
    dark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  document.documentElement.classList.toggle('dark', dark);
})();
