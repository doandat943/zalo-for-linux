/*
 * inject.js
 * This script is injected into the Zalo renderer via executeJavaScript.
 * It periodically checks for the .nav__tabs__bottom container and,
 * once found on the main Zalo page, inserts the Zalux sidebar button.
*/

(function () {
  // Color palettes
  const COLORS = {
    original: {
      icon: '#FFFFFF',
      iconHover: '#FFFFFF',
      bg: 'rgba(255, 255, 255, 0.1)',
      bgHover: 'rgba(255, 255, 255, 0.2)'
    },
    zadark: {
      icon: '#7589a3',
      iconHover: '#005ae0',
      bg: 'rgba(117, 133, 163, 0.1)',
      bgHover: 'rgba(117, 133, 163, 0.2)'
    }
  };

  function getColors() {
    const isZaDark = document.body.classList.contains('zadark') ||
                     document.body.classList.contains('zadark-pc');

    return isZaDark ? COLORS.zadark : COLORS.original;
  }

  function createButton() {
    const colors = getColors();

    // Button container
    const btn = document.createElement('div');
    btn.id = 'zalux-btn';
    btn.title = 'Zalux';
    btn.style.cssText = [
      'width: 64px',
      'height: 64px',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'cursor: pointer',
      'position: relative',
      'border-radius: 8px'
    ].join('; ');

    // Icon background
    const inner = document.createElement('div');
    inner.style.cssText = [
      'width: 36px',
      'height: 36px',
      'border-radius: 50%',
      'background: ' + colors.bg,
      'display: flex',
      'align-items: center',
      'justify-content: center'
    ].join('; ');

    // Download icon
    inner.innerHTML = [
      '<svg',
        ' width="20"',
        ' height="20"',
        ' viewBox="0 0 24 24"',
        ' fill="none"',
        ' stroke="' + colors.icon + '"',
        ' stroke-width="2"',
        ' stroke-linecap="round"',
        ' stroke-linejoin="round"',
      '>',
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
        '<polyline points="7 10 12 15 17 10"/>',
        '<line x1="12" y1="15" x2="12" y2="3"/>',
      '</svg>'
    ].join('');

    // Update badge
    const badge = document.createElement('div');
    badge.id = 'zalu-badge';
    badge.style.cssText = [
      'position: absolute',
      'top: 12px',
      'right: 12px',
      'width: 8px',
      'height: 8px',
      'background: #ef4444',
      'border-radius: 50%',
      'display: none',
      'outline: 2px solid white'
    ].join('; ');

    // Hover effects
    btn.onmouseover = function () {
      inner.style.background = colors.bgHover;
      inner.querySelector('svg').style.stroke = colors.iconHover;
    };

    btn.onmouseout = function () {
      inner.style.background = colors.bg;
      inner.querySelector('svg').style.stroke = colors.icon;
    };

    // Click to open Zalux
    btn.onclick = function () {
      const oldTitle = document.title;
      document.title = 'ZALUX_TRIGGER';
      setTimeout(function () {
        document.title = oldTitle;
      }, 100);
    };

    btn.appendChild(inner);
    btn.appendChild(badge);
    return btn;
  }

  function injectButton() {
    if (document.getElementById('zalux-btn')) {
      return;
    }

    const bottomNav = document.querySelector('.nav__tabs__bottom');
    if (!bottomNav || !location.href.includes('index.html')) {
      return;
    }

    const btn = createButton();
    bottomNav.insertAdjacentElement('afterbegin', btn);
  }

  // Poll until button is injected
  const checkInterval = setInterval(function () {
    injectButton();
    if (document.getElementById('zalux-btn')) {
      clearInterval(checkInterval);
    }
  }, 1000);
})();