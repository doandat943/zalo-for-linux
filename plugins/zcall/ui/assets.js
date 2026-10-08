/**
 * plugins/zcall/ui/assets.js (renderer)
 *
 * The page gets app/zcall-assets/ in its ?assets= query (scripts/
 * extract-zcall-assets.js puts Zalo's own call icons, sounds and the Zalo
 * Segoe UI fonts there). Fills every <img data-a="…"> and loads the fonts.
 */

(() => {
'use strict';

const params = new URLSearchParams(location.search);
const ASSETS = params.get('assets') || '';

function assetUrl(rel) {
  return 'file://' + ASSETS.split('/').map(encodeURIComponent).join('/') + '/' + rel.split('/').map(encodeURIComponent).join('/');
}

// Icons, by their path in ZaloCall's resources.
const ICON = {
  end: 'icon2/resources/offical-v2/endcall.png',
  acceptAudio: 'icon2/resources/offical-v2/accept_audiocall.png',
  acceptVideo: 'icon2/resources/offical-v2/accept_videocall.png',
  cam: 'icon2/resources/offical-v2/camera1.png',
  camOff: 'icon2/resources/offical-v2/camera_off1.png',
  camDisabled: 'icon2/resources/offical-v2/camera_disabled1.png',
  mic: 'icon2/resources/offical-v2/mic1.png',
  micOff: 'icon2/resources/offical-v2/mic_off1.png',
  micDisabled: 'icon2/resources/offical-v2/mic_disabled1.png',
  menuMic: 'icon2/resources/offical-v2/mic3.png',
  menuSpeaker: 'icon2/resources/offical-v2/speak.png',
  caret: 'icon/resources/svg/dropup.svg',
  caretDisabled: 'icon/resources/svg/dropupdisable.svg',
  setting: 'icon/resources/svg/setting.svg',
  share: 'icon/resources/svg/sharescreen.svg',
  shareOff: 'icon/resources/svg/sharescreenoff.svg',
  grid: 'icon/resources/svg/grid.svg',
  close: 'icon/resources/offical/close_white.png',
  check: 'icon/resources/offical/icn_callsetting_check.png',
};

const SOUND = {
  ringtone: 'sound/zalo_ringtone.mp3',
  ringback: 'sound/zalo_ringback.mp3',
  end: 'sound/endcall.mp3',
};

function setIcon(img, name) {
  const url = assetUrl(ICON[name]);
  if (img.getAttribute('src') !== url) img.setAttribute('src', url);
}

for (const img of document.querySelectorAll('img[data-a]')) setIcon(img, img.dataset.a);

// Zalo Segoe UI, as Zalo itself ships it in pc-dist.
for (const [weight, file] of [['400', 'Regular'], ['600', 'Semibold'], ['700', 'Bold']]) {
  const face = new FontFace('Zalo Segoe UI', `url("${assetUrl('fonts/ZaloSegoeUI-' + file + '.ttf')}")`, { weight });
  face.load().then((f) => document.fonts.add(f)).catch(() => { /* the fallback fonts stay */ });
}

// One looping or one-shot sound at a time per name.
const playing = {};
function playSound(name, loop) {
  if (playing[name]) return;
  const a = new Audio(assetUrl(SOUND[name]));
  a.loop = !!loop;
  playing[name] = a;
  a.addEventListener('ended', () => { if (playing[name] === a) delete playing[name]; });
  a.play().catch(() => { delete playing[name]; });
}
function stopSound(name) {
  const a = playing[name];
  if (!a) return;
  delete playing[name];
  a.pause();
}

window.zcallAssets = { assetUrl, setIcon, playSound, stopSound, params };
})();
