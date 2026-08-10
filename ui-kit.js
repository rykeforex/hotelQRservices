/**
 * ui-kit.js
 *
 * Shared, dependency-free luxury UI feedback kit: toast notifications and
 * button loading states. Include it once per page (inline or external).
 *
 * Usage:
 *   LuxeUI.toast('success', 'Welcome back', 'Redirecting to your dashboard…');
 *   LuxeUI.toast('error', 'Sign in failed', 'Check your email and password.');
 *
 *   LuxeUI.loading(myButton, true, 'Signing in…');   // start
 *   LuxeUI.loading(myButton, false);                  // stop, restores original content
 *
 * Self-contained: injects its own <style> once, doesn't require any other
 * file, and never throws if called before the DOM is fully ready.
 */
(function (global) {
  var STYLE_ID = 'luxe-ui-styles';
  var CONTAINER_ID = 'luxe-toast-container';
  var originalContent = new WeakMap();

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${CONTAINER_ID} {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-width: min(380px, calc(100vw - 32px));
        pointer-events: none;
      }
      .luxe-toast {
        pointer-events: auto;
        position: relative;
        overflow: hidden;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 16px 18px;
        border-radius: 16px;
        background: linear-gradient(150deg, rgba(24,22,18,0.96), rgba(15,14,12,0.98));
        border: 1px solid rgba(201,168,76,0.35);
        box-shadow: 0 18px 40px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02) inset;
        color: #f4efe3;
        font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        cursor: pointer;
        animation: luxeToastIn 0.45s cubic-bezier(.16,1,.3,1);
        backdrop-filter: blur(14px);
      }
      .luxe-toast.leaving { animation: luxeToastOut 0.35s ease forwards; }
      .luxe-toast::before {
        content: '';
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 3px;
      }
      .luxe-toast.success::before { background: linear-gradient(180deg, #c9a84c, #e2c47a); }
      .luxe-toast.error::before { background: linear-gradient(180deg, #b3492f, #d97256); }
      .luxe-toast.info::before { background: linear-gradient(180deg, #8a8070, #b7ac95); }
      .luxe-toast-icon {
        flex-shrink: 0;
        width: 26px; height: 26px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        margin-top: 1px;
      }
      .luxe-toast.success .luxe-toast-icon { background: rgba(201,168,76,0.16); color: #e2c47a; }
      .luxe-toast.error .luxe-toast-icon { background: rgba(179,73,47,0.18); color: #e79176; }
      .luxe-toast.info .luxe-toast-icon { background: rgba(138,128,112,0.18); color: #cfc6b4; }
      .luxe-toast-icon svg { width: 15px; height: 15px; }
      .luxe-toast-body { flex: 1; min-width: 0; }
      .luxe-toast-title { font-size: 13.5px; font-weight: 600; letter-spacing: 0.01em; line-height: 1.35; }
      .luxe-toast-message { font-size: 12.5px; color: #b9b0a0; margin-top: 3px; line-height: 1.45; }
      .luxe-toast-progress {
        position: absolute; left: 0; bottom: 0; height: 2px;
        background: linear-gradient(90deg, #c9a84c, #e2c47a);
        animation-name: luxeToastProgress;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
      }
      @keyframes luxeToastIn {
        from { opacity: 0; transform: translateX(24px) scale(0.97); }
        to { opacity: 1; transform: translateX(0) scale(1); }
      }
      @keyframes luxeToastOut {
        to { opacity: 0; transform: translateX(24px) scale(0.97); }
      }
      @keyframes luxeToastProgress {
        from { width: 100%; } to { width: 0%; }
      }
      .luxe-btn-spinner {
        display: inline-block;
        width: 15px; height: 15px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: #fff;
        animation: luxeSpin 0.7s linear infinite;
        vertical-align: -3px;
        margin-right: 8px;
      }
      @keyframes luxeSpin { to { transform: rotate(360deg); } }
      .luxe-loading { opacity: 0.85; cursor: progress !important; pointer-events: none; }
      @media (max-width: 480px) {
        #${CONTAINER_ID} { left: 16px; right: 16px; top: 16px; max-width: none; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureContainer() {
    var el = document.getElementById(CONTAINER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = CONTAINER_ID;
      document.body.appendChild(el);
    }
    return el;
  }

  var ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  function toast(type, title, message, duration) {
    try {
      ensureStyles();
      var container = ensureContainer();
      type = ICONS[type] ? type : 'info';
      duration = duration || (type === 'error' ? 6000 : 4200);

      var el = document.createElement('div');
      el.className = 'luxe-toast ' + type;
      el.innerHTML =
        '<span class="luxe-toast-icon">' + ICONS[type] + '</span>' +
        '<span class="luxe-toast-body">' +
          '<span class="luxe-toast-title"></span>' +
          (message ? '<span class="luxe-toast-message"></span>' : '') +
        '</span>' +
        '<span class="luxe-toast-progress" style="animation-duration:' + duration + 'ms;"></span>';
      el.querySelector('.luxe-toast-title').textContent = title || '';
      if (message) el.querySelector('.luxe-toast-message').textContent = message;

      function dismiss() {
        if (el.classList.contains('leaving')) return;
        el.classList.add('leaving');
        setTimeout(function () { el.remove(); }, 350);
      }
      el.addEventListener('click', dismiss);
      var timer = setTimeout(dismiss, duration);
      el.addEventListener('mouseenter', function () { clearTimeout(timer); });
      el.addEventListener('mouseleave', function () { timer = setTimeout(dismiss, 1200); });

      container.appendChild(el);
      return el;
    } catch (err) {
      // Never let a UI-polish failure break the actual auth flow.
      console.warn('LuxeUI.toast failed:', err.message);
    }
  }

  function loading(button, isLoading, label) {
    if (!button) return;
    try {
      ensureStyles();
      if (isLoading) {
        if (!originalContent.has(button)) originalContent.set(button, button.innerHTML);
        button.innerHTML = '<span class="luxe-btn-spinner"></span>' + (label || 'Please wait…');
        button.classList.add('luxe-loading');
        button.disabled = true;
      } else {
        if (originalContent.has(button)) {
          button.innerHTML = originalContent.get(button);
          originalContent.delete(button);
        }
        button.classList.remove('luxe-loading');
        button.disabled = false;
      }
    } catch (err) {
      console.warn('LuxeUI.loading failed:', err.message);
    }
  }

  global.LuxeUI = { toast: toast, loading: loading };
})(window);