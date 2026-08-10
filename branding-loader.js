/**
 * branding-loader.js
 *
 * Drop-in script for guest/staff-facing pages (index.html, request.html,
 * director_dashboard.html, department_dashboard.html). Reads `hotelId` from
 * the URL, fetches public branding from the backend, and applies it:
 *   - favicon
 *   - CSS custom-property color theming (only on pages that define --gold)
 *   - Tailwind arbitrary-value color overrides (department_dashboard.html)
 *   - hotel name into the guest logo text (request.html)
 *
 * Fails silently on any error so a missing/misconfigured hotel never breaks
 * the page. Include it once per page (inline or external), near the end
 * of the body.
 */
(function () {
  function getHotelId() {
    try {
      var params = new URLSearchParams(window.location.search);
      var id = parseInt(params.get('hotelId') || '', 10);
      return id || null;
    } catch (e) {
      return null;
    }
  }

  function resolveApiBase() {
    var host = window.location.hostname;
    return (host === 'localhost' || host === '127.0.0.1')
      ? 'http://localhost:3000'
      : 'https://hotelqrservices-production.up.railway.app';
  }

  function setFavicon(url) {
    if (!url) return;
    var link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = url;
  }

  function hexToRgba(hex, alpha) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return null;
    var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  // Only applies to pages that already theme themselves via a --gold custom
  // property (index.html, director_dashboard.html). Pages without it are
  // left untouched.
  function applyCssVarTheme(colors) {
    if (!colors || !colors.primary) return;
    var root = document.documentElement;
    var existing = getComputedStyle(root).getPropertyValue('--gold').trim();
    if (!existing) return;
    root.style.setProperty('--gold', colors.primary);
    if (colors.accent) root.style.setProperty('--gold-light', colors.accent);
    var dim = hexToRgba(colors.primary, 0.18);
    var glow = hexToRgba(colors.primary, 0.32);
    if (dim) root.style.setProperty('--gold-dim', dim);
    if (glow) root.style.setProperty('--gold-glow', glow);
  }

  // department_dashboard.html uses hardcoded Tailwind arbitrary-value
  // classes (text-[#b49450], bg-[#b49450], hover:bg-[#a08040], etc.)
  // instead of a CSS variable. Only inject the override if those exact
  // classes are present, so this is a no-op on every other page.
  function applyDeptDashboardOverrides(colors) {
    if (!colors || !colors.primary) return;
    if (!document.querySelector('[class*="b49450"]')) return;
    var primary = colors.primary;
    var hover = colors.secondary || colors.accent || primary;
    var style = document.createElement('style');
    style.id = 'brandingOverride';
    style.textContent =
      '.text-\\[\\#b49450\\]{color:' + primary + ' !important;}' +
      '.bg-\\[\\#b49450\\]{background-color:' + primary + ' !important;}' +
      '.border-\\[\\#b49450\\]{border-color:' + primary + ' !important;}' +
      '.hover\\:bg-\\[\\#a08040\\]:hover{background-color:' + hover + ' !important;}' +
      '.hover\\:text-\\[\\#b49450\\]:hover{color:' + primary + ' !important;}' +
      '.focus\\:ring-\\[\\#b49450\\]:focus{--tw-ring-color:' + primary + ' !important;}' +
      '.focus\\:border-\\[\\#b49450\\]:focus{border-color:' + primary + ' !important;}';
    document.head.appendChild(style);
  }

  // request.html has a dedicated .logo-text element for the hotel name —
  // safe, single-node swap. Everything else on that page stays as-is.
  function applyLogoText(hotelName) {
    if (!hotelName) return;
    var logoText = document.querySelector('.logo-text');
    if (logoText) logoText.textContent = hotelName.toUpperCase();
  }

  async function init() {
    var hotelId = getHotelId();
    if (!hotelId) return;
    try {
      var res = await fetch(resolveApiBase() + '/api/branding/public?hotelId=' + hotelId);
      if (!res.ok) return;
      var data = await res.json();

      setFavicon(data.faviconUrl);
      applyCssVarTheme(data.brandColors);
      applyDeptDashboardOverrides(data.brandColors);
      applyLogoText(data.hotelName);

      // Expose the full payload for pages that want to use more of it
      // (e.g. a future welcome-message banner) without re-fetching.
      window.hotelBranding = data;
      document.dispatchEvent(new CustomEvent('hotelBrandingLoaded', { detail: data }));
    } catch (err) {
      console.warn('Branding load skipped:', err.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();