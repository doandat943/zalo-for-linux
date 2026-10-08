// Injected into the Zalo window by plugins/zcall-bridge (injectSwitch).
// Adds a "Tính năng gọi điện" switch to the ZaDark popup, styled like
// ZaDark's own switches (#80), and a "Cài đặt gọi điện" entry to Zalo's own
// settings menu, which every variant has (the tray is invisible on stock
// GNOME). The page cannot reach the main process, so a change is
// signalled through the window title (as the userscripts menu does); the
// main process pushes the state back with window.__zcallSwitchUpdate().
(function () {
  if (window.__zcallSwitchInstalled) return;
  window.__zcallSwitchInstalled = true;

  const TITLE_PREFIX = 'ZCALL_SWITCH_TRIGGER:';
  let state = window.__zcallSwitchState || { enabled: true, note: '' };

  const style = document.createElement('style');
  // ZaDark's own rules are scoped under #zadark-popup: match that so these
  // win. The switch itself keeps ZaDark's colors.
  style.textContent = [
    '#zcall-switch-panel .zcall-switch__note{display:block;margin-top:2px;font-size:12px;line-height:1.4;opacity:.7}',
    '#zcall-switch-panel .zcall-switch__settings{display:inline-block;margin-top:2px;font-size:12px;color:var(--zadark-primary-base);cursor:pointer}',
    '#zcall-switch-panel .zcall-switch__settings:hover{text-decoration:underline}'
  ].join('');
  document.head.appendChild(style);

  function render() {
    const input = document.getElementById('js-switch-zcall');
    if (input) input.checked = !!state.enabled;
    const note = document.getElementById('zcall-switch-note');
    if (note) note.textContent = state.note || '';
  }

  function send(command) {
    const previousTitle = document.title;
    document.title = TITLE_PREFIX + command;
    setTimeout(function () { document.title = previousTitle; }, 100);
  }

  function addSwitch() {
    if (document.getElementById('zcall-switch-panel')) return;
    const main = document.querySelector('#js-zadark-popup .zadark-popup__main');
    if (!main) return;
    const panel = document.createElement('div');
    panel.id = 'zcall-switch-panel';
    panel.className = 'zadark-panel';
    panel.innerHTML = '<div class="zadark-panel__body"><div class="zadark-switch__list">'
      + '<div class="zadark-switch">'
      + '<div class="zadark-switch__label">'
      + '<label for="js-switch-zcall">Tính năng gọi điện</label>'
      + '<span class="zcall-switch__note" id="zcall-switch-note"></span>'
      + '<a class="zcall-switch__settings" id="zcall-switch-settings">Cài đặt nâng cao…</a>'
      + '</div>'
      + '<label class="zadark-switch__checkbox">'
      + '<input class="zadark-switch__input" type="checkbox" id="js-switch-zcall">'
      + '<span class="zadark-switch__slider"></span>'
      + '</label></div></div></div>';
    main.appendChild(panel);
    panel.querySelector('#js-switch-zcall').addEventListener('change', function () {
      send(this.checked ? 'on' : 'off');
    });
    panel.querySelector('#zcall-switch-settings').addEventListener('click', function () {
      send('settings');
    });
    render();
  }

  // Same markup as Zalo's own items (and the userscripts entry).
  function addMenuItem() {
    if (document.getElementById('zcall-setting-item')) return;
    const containers = document.querySelectorAll('#setting .setting-menu');
    if (!containers.length) return;
    const container = containers[containers.length - 1];
    const reference = container.querySelector('.setting-menu__item');
    const item = document.createElement('div');
    item.id = 'zcall-setting-item';
    item.className = reference ? reference.className : 'setting-menu__item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.title = 'Bật/tắt tính năng gọi điện và cấu hình Wine';
    item.innerHTML = '<div class="setting-menu__wrapper-content truncate">'
      + '<div class="setting-menu__icon" style="display:flex;align-items:center;justify-content:center">'
      + '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'
      + '</svg></div><p class="setting-menu__name truncate">Cài đặt gọi điện</p></div>';
    item.addEventListener('click', function () { send('settings'); });
    item.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); send('settings'); }
    });
    container.appendChild(item);
  }

  window.__zcallSwitchUpdate = function (next) {
    state = next;
    render();
  };

  window.__zcallCameraRefresh = function () {
    const label = document.querySelector('.setting [data-translate-inner="STR_VIDEO_CALL_SETTINGS"]');
    const calls = label && label.closest('.setting-menu__item');
    if (!calls || !calls.classList.contains('selected')) return;
    const settings = calls.closest('.setting');
    const general = Array.from(settings.querySelectorAll('.setting-menu__item')).find(function (item) {
      return item !== calls && !item.id;
    });
    if (!general) return;
    // remount this tab to reuse Zalo's device query; use its refresh API if one is exposed.
    general.click();
    setTimeout(function () {
      if (settings.isConnected && general.classList.contains('selected')) calls.click();
    }, 0);
  };

  addSwitch();
  addMenuItem();
  let settingsOpen = !!document.getElementById('setting');
  let queued = false;
  new MutationObserver(function () {
    const open = !!document.getElementById('setting');
    if (settingsOpen && !open) send('settings-closed');
    settingsOpen = open;
    if (queued) return;
    if (document.getElementById('zcall-switch-panel') &&
        (document.getElementById('zcall-setting-item') || !document.querySelector('#setting .setting-menu'))) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      addSwitch();
      addMenuItem();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
