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
  stopSound('ringtone');
  ipcRenderer.send('zcall-incoming-answer', { camStartOff: !!camStartOff });
}
function decline() {
  if (answered) return;
  answered = true;
  stopSound('ringtone');
  act('reject');
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
});
ipcRenderer.on('zcall-incoming-stop', () => { stopSound('ringtone'); });
