# zcall-native — Zalo calls on Linux

Native Linux call engine for Zalo-Linux: it speaks Zalo's call-v2 IPC, the
ZRTP relay protocol, P2P, SRTP, Opus and H.264 itself, in place of Zalo's
`ZaloCall` helper. **Generated** by `tools/export-engine.sh` of
Zalo-Linux-Native-Dev at commit `b331561`: edit it there (protocol notes, tests,
captures), then export again.

## What works

- 1-1 voice and video calls, making and answering (answer / decline / either
  side hangs up); P2P with a phone on the same network, relay otherwise
- call window (plugins/zcall): camera both ways, mute, speaker off,
  microphone / speaker / camera picker, the peer's camera and mic state,
  minimize / compact
- sharing the screen in 1-1 video calls (PipeWire portal on Wayland)
- WebRTC echo cancellation, noise suppression and gain control (PipeWire)
- group calls (on by default, `ZCALL_GROUP=0` turns them off): audio, our
  camera (one 720x360 layer, `ZCALL_GROUP_CAM_LAYER`), our screen on its own
  peer (UID = shareScreenId, `ZCALL_SHARE_RES`), the members' cameras. Tried
  with a phone and Zalo for macOS; the packet formats were checked against a
  capture of the macOS client (layer tables, SFU / abs-send-time / capture-time
  extensions, ZaviPing)

## How Zalo-Linux runs it

The patched main process (scripts/patches/patch-zcall-native.js) spawns
`native-engine/zcall-native.js` on Zalo's own Electron
(`ELECTRON_RUN_AS_NODE`) when a call starts, with the two loopback ports
and a fresh token; plugins/zcall sets the environment (`ZCALL_ENGINE_JS`,
`ZCALL_LOG_DIR`, ...) and checks the system packages.

Needs `python3` and libopus, plus PipeWire/PulseAudio (`parec`, `pacat`,
`pactl`) or ALSA (`arecord`, `aplay`).

Log: `~/.config/ZaloData/native-engine-YYYYMMDD.log` (`ZCALL_VERBOSE=1` logs
whole IPC frames, which contain ids — keep them private).
