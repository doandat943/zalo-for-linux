/**
 * plugins/zcall/ui/incoming.js (renderer): the incoming call notice.
 * State from plugins/zcall/incoming.js ('zcall-incoming-state'); the
 * answer goes back as 'zcall-ui-action' like the call window's clicks.
 */

'use strict';

const { ipcRenderer } = require('electron');
const { setIcon, playSound, stopSound } = window.zcallAssets;
const $ = (id) => document.getElementById(id);
const act = (action, extra) => ipcRenderer.send('zcall-ui-action', Object.assign({ action }, extra || {}));

let answered = false;
function answer(camStartOff) {
  if (answered) return;
  answered = true;
  stopShake();
  stopSound('ringtone');
  ipcRenderer.send('zcall-incoming-answer', { camStartOff: !!camStartOff });
}
function decline() {
  if (answered) return;
  answered = true;
  stopShake();
  stopSound('ringtone');
  act('reject');
}
// The answer button rings as Zalo for macOS's (ZButton::addAnimation, from
// ZCalleeWindow::_initGenericUi, disassembled 2026-10-10): a 600 ms timer flips
// between shaking and resting (waitToAnimate); while shaking, every 40 ms the phase
// grows by pi/2 (animate) and the icon is drawn turned by sin(phase) x 15 degrees
// about its centre (paintEvent: translate, rotate, drawPixmap): 0, +15, 0, -15, ...
const SHAKE_MS = 600, TICK_MS = 40, SHAKE_DEG = 15;
let shakeTimer = null, tickTimer = null, phase = 0;
function stopShake() {
  clearInterval(shakeTimer); clearInterval(tickTimer);
  shakeTimer = tickTimer = null; phase = 0;
  $('acceptIcon').style.transform = '';
}
function startShake() {
  if (shakeTimer) return;
  let shaking = false;
  const flip = () => {
    shaking = !shaking;
    clearInterval(tickTimer); tickTimer = null; phase = 0;
    $('acceptIcon').style.transform = '';
    if (shaking) tickTimer = setInterval(() => {
      phase += Math.PI / 2;
      $('acceptIcon').style.transform = 'rotate(' + (Math.sin(phase) * SHAKE_DEG).toFixed(3) + 'deg)';
    }, TICK_MS);
  };
  shakeTimer = setInterval(flip, SHAKE_MS);
  flip();
}
$('accept').onclick = () => answer(false);
$('noCam').onclick = () => answer(true);
$('reject').onclick = decline;
$('close').onclick = decline;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') decline(); });

ipcRenderer.on('zcall-incoming-state', (_e, s) => {
  const name = s.name || 'Zalo';
  document.title = name + ' - Zalo';
  $('name').textContent = name;
  const sub = $('sub');
  sub.textContent = '';
  if (s.inviter) {
    // "<b>Người gọi</b> mời bạn vào cuộc gọi nhóm"
    const b = document.createElement('b');
    b.textContent = s.inviter;
    sub.append(b, ' mời bạn vào cuộc gọi nhóm');
  } else {
    sub.textContent = s.noAnswer ? (s.text || '') : 'Zalo: ' + (s.text || (s.video ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến'));
  }
  sub.title = sub.textContent;
  const av = $('avatar');
  if (s.avatar) { av.style.backgroundImage = 'url("' + String(s.avatar).replace(/["\\\n]/g, '') + '")'; av.textContent = ''; }
  else { av.style.backgroundImage = ''; av.textContent = name.trim().charAt(0).toUpperCase(); }
  // A call we cannot take: only declining / closing.
  $('accept').classList.toggle('hide', !!s.noAnswer);
  setIcon($('acceptIcon'), s.video ? 'acceptVideo' : 'acceptAudio');
  $('noCam').classList.toggle('hide', !s.video || !!s.noAnswer);
  if (!answered) playSound('ringtone', true);
  if (!answered && !s.noAnswer) startShake(); else stopShake();
});
ipcRenderer.on('zcall-incoming-stop', () => { stopSound('ringtone'); stopShake(); });
