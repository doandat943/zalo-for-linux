/**
 * updater-inject.js
 * This script is injected into the Zalo renderer via executeJavaScript.
 * It periodically checks for the .nav__tabs__bottom container and,
 * once found on the main Zalo page, inserts the Linux Updater icon button.
 */

setInterval(() => {
  const bottomNav = document.querySelector('.nav__tabs__bottom');
  if (!bottomNav || document.getElementById('zalo-linux-updater') || !location.href.includes('index.html')) {
    return;
  }

  const inner = document.createElement('div');
  inner.style.cssText = [
    'width: 36px',
    'height: 36px',
    'border-radius: 50%',
    'background: rgba(150, 150, 150, 0.15)',
    'display: flex',
    'align-items: center',
    'justify-content: center'
  ].join('; ');

  inner.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24"
      fill="none" stroke="#7589A3" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  `;

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

  const btn = document.createElement('div');
  btn.id = 'zalo-linux-updater';
  btn.title = 'Cập nhật Zalo cho Linux';
  btn.style.cssText = [
    'width: 64px',
    'height: 64px',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'cursor: pointer',
    'position: relative'
  ].join('; ');

  btn.appendChild(inner);
  btn.appendChild(badge);

  btn.onmouseover = () => inner.style.background = 'rgba(150, 150, 150, 0.3)';
  btn.onmouseout  = () => inner.style.background = 'rgba(150, 150, 150, 0.15)';

  btn.onclick = () => {
    const oldTitle = document.title;
    document.title = 'ZALO_UPDATER_TRIGGER';
    setTimeout(() => document.title = oldTitle, 100);
  };

  bottomNav.insertAdjacentElement('afterbegin', btn);
}, 2000);
