#!/usr/bin/env python3
"""Audio side of the native call engine: microphone -> Opus, Opus -> speaker.

Spawned by backends/zrtc-media.js; network, SRTP and signalling stay in Node.
Opus 16 kHz mono, 20 ms frames (opus/16000/1, PT 112).

Framing on the pipes (big endian):
  stdout  'L' u8 level, u16 len, Opus one encoded 20 ms microphone frame; level is
                                      its loudness in -dBov, 0..127 (RFC 6464, 127 =
                                      silence), for the group audio-level extension
  stdin   'F' u32 idx, u32 src, u16 len, Opus
                                      one received frame; idx = ROC<<16 | seq
          'M' u8 on                   mute the microphone (sends silence)
          'S' u8 on                   speaker off (received audio is played as silence)
          'D' u8 kind, u16 len, name  use another PulseAudio source (kind 'i') or
                                      sink ('o') now; empty name: the default
Stops when stdin closes. Logs go to stderr.

  --tone   send a 440 Hz tone instead of the microphone (for tests)
  --mix    group call (several sources); every call has one jitter buffer per
           source (src = SSRC), decoded and mixed every 20 ms on the sound card's clock
  --mic / --speaker   PulseAudio source / sink to use (else ZCALL_MIC / ZCALL_SPEAKER, else the default)
  --min-delay MS      least jitter buffer depth (zrtc_config minAudioDelayMs; 100 by default)

Every DIAG_SEC (10 s) the log gets one "diag:" line for the test calls: the
playout counters of that period, how full the sound card stream was, the
microphone's longest gap, and from PipeWire (pw-top, journal) the graph's
quantum, new overruns of the devices in use and speaker resyncs.
ZCALL_AUDIO_DIAG=0 turns it off.

ZCALL_AUDIO_DUMP=1 (off by default: it records the call) also writes what was
played and what the microphone sent, raw 16 kHz mono s16le, to
<ZCALL_LOG_DIR>/call-<time>-played.raw and -mic.raw (after the processing,
before Opus; silence while muted), to find where speech breaks up.

With PipeWire the microphone goes through WebRTC audio processing (echo
cancellation and noise suppression), as the real engine does
(zrtc_config audioEchoCancellation / audioNoiseSuppression), and received
audio is played through it as the echo reference. The high-pass filter is on
unless --no-high-pass (a group call whose zrtcConfig has audioHighPassFilter
false). ZCALL_AUDIO_PROCESSING=0 turns processing off. No gain control:
PipeWire's webrtc.gain_control turns on two digital AGCs at once (AGC1
adaptive digital + AGC2), which pump the noise up and distort loud speech;
the real engine uses one analog AGC (AgcManagerDirect, the OS microphone
volume). Do not turn gain_control on from here.
"""
from __future__ import annotations

import argparse
import ctypes
import signal
import tempfile
import time
import math
import os
import shlex
import shutil
import struct
import subprocess
import sys
import threading
from array import array
from collections import Counter, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from opus_play import DEFAULT_DEVICE, FRAME, Sink, load_opus, new_decoder, pulse_running  # noqa: E402

OPUS_APPLICATION_VOIP = 2048
OPUS_SET_BITRATE = 4002
OPUS_SET_COMPLEXITY = 4010
OPUS_SET_INBAND_FEC = 4012
OPUS_SET_PACKET_LOSS_PERC = 4014
OPUS_SET_SIGNAL = 4024
OPUS_SIGNAL_VOICE = 3001
FRAME_BYTES = FRAME * 2

log = lambda *a: print("[audio-io]", *a, file=sys.stderr, flush=True)  # noqa: E731


def pulse_names(kind: str) -> list[str]:
    """Names of the PulseAudio "sources" or "sinks" (empty if pactl fails)."""
    try:
        out = subprocess.run(["pactl", "list", "short", kind], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [c[1] for c in (line.split("\t") for line in out.splitlines()) if len(c) > 1]


def present(name: str | None, kind: str) -> str | None:
    """`name` if that device exists now (a headset may have been unplugged), else None."""
    if not name:
        return None
    if name in pulse_names(kind):
        return name
    log(f"{name} not found; using the default")
    return None


def pulse_mic() -> str | None:
    """A real microphone when the default source is silent by design.

    Installing Iriun Webcam loads snd-aloop, and PipeWire may then pick its
    loopback (or a monitor) as the default source: the call goes out silent.
    ZCALL_MIC names a source explicitly."""
    if os.environ.get("ZCALL_MIC"):
        return os.environ["ZCALL_MIC"]
    try:
        default = subprocess.run(["pactl", "get-default-source"], capture_output=True, text=True, timeout=3).stdout.strip()
        if default and "aloop" not in default and not default.endswith(".monitor"):
            return None
        names = subprocess.run(["pactl", "list", "short", "sources"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in names.splitlines():
        cols = line.split("\t")
        name = cols[1] if len(cols) > 1 else ""
        if name.startswith("alsa_input.") and "aloop" not in name:
            log(f"default source {default} is a loopback; using {name}")
            return name
    return None


def default_source() -> str | None:
    try:
        return subprocess.run(["pactl", "get-default-source"], capture_output=True, text=True, timeout=3).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def mic_command(device: str | None, source: str | None = None):
    if device is None and pulse_running():
        src = present(source, "sources") or pulse_mic()
        return ["parec", *(["-d", src] if src else []), "--raw", "--rate=16000", "--channels=1", "--format=s16le", "--latency-msec=20"]
    return ["arecord", "-q", "-D", device or DEFAULT_DEVICE, "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1"]


def speaker_command(sink: str | None):
    return ["pacat", *(["-d", sink] if sink else []), "--raw", "--rate=16000", "--channels=1", "--format=s16le", "--latency-msec=60"]


class Mic:
    """The microphone process; switch() replaces it mid-call. The encoder
    thread reads frames(), the stdin thread calls switch()."""

    def __init__(self, device: str | None, source: str | None):
        self.device = device
        self.proc = None
        self.gap_max = 0.0   # longest wait for one 20 ms frame, this diag period
        self.gaps = 0        # waits over 60 ms (the capture stalled)
        self.switch(source)

    def switch(self, source: str | None):
        cmd = mic_command(self.device, source)
        log("mic:", " ".join(cmd))
        old, self.proc = self.proc, subprocess.Popen(cmd, stdout=subprocess.PIPE)
        if old:
            old.kill()
            old.wait()

    def frames(self):
        last = None
        while True:
            proc = self.proc
            pcm = read_exact(proc.stdout, FRAME_BYTES)
            now = time.monotonic()
            if last is not None and pcm is not None:
                self.gap_max = max(self.gap_max, now - last)
                if now - last > 0.06:
                    self.gaps += 1
            last = now
            if pcm is None:
                if proc is not self.proc:
                    continue  # switched: read from the new one
                log("microphone stream ended")
                return
            yield pcm


def switch_speaker(sink, name: str | None):
    """Play through another PulseAudio sink from now on (PulseOut, or Sink from opus_play)."""
    if isinstance(sink, PulseOut):
        sink.switch(present(name, "sinks"))
        return
    cmd = speaker_command(present(name, "sinks"))
    log("player:", " ".join(cmd))
    old, sink.proc = sink.proc, subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        old.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    old.wait()


# Realtime for the processing: module-rt asks xdg-desktop-portal first, and on
# this Debian 13 the portal fails ("Realtime error: Could not get pidns for pid
# ...: Not a directory"), so the threads stayed at normal priority. RTKit
# directly (rtportal.enabled = false) gives data-loop.0 RR 20.
# The graph period stays the one module-echo-cancel asks for (10 ms -> quantum
# 256): at 512 its sink path broke the sound every 10 ms (1 kHz played as
# 964.8 Hz, THD+N -3 dB instead of -40 dB, measured on the USB headset
# 2026-10-09), whatever node.latency or audio.rate was given.
EC_CONF = """context.properties = { log.level = 0 }
context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    support.*       = support/libspa-support
}
context.modules = [
    { name = libpipewire-module-rt args = { nice.level = -11 rt.prio = 88 rtportal.enabled = false } flags = [ ifexists nofail ] }
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-echo-cancel
      args = {
        library.name = aec/libspa-aec-webrtc
        aec.args = {
            webrtc.gain_control = false
            webrtc.noise_suppression = true
            webrtc.high_pass_filter = @HPF@
            webrtc.extended_filter = true
            webrtc.delay_agnostic = true
        }
        audio.rate = 16000
        audio.channels = 1
        audio.position = [ MONO ]
        capture.props  = { node.name = "@TAG@.capture" node.passive = true @MIC@ }
        source.props   = { node.name = "@TAG@_source" node.description = "Zalo call microphone (processed)" priority.session = 0 priority.driver = 0 }
        sink.props     = { node.name = "@TAG@_sink" node.description = "Zalo call speaker (processed)" priority.session = 0 priority.driver = 0 }
        playback.props = { node.name = "@TAG@.playback" node.passive = true @SPEAKER@ }
      }
    }
]
"""


def _die_with_parent():
    # The pipewire child goes away with us, even when we are killed.
    try:
        ctypes.CDLL("libc.so.6").prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except OSError:
        pass


SCHED = {0: "TS", 1: "FIFO", 2: "RR", 3: "BATCH", 5: "IDLE", 6: "DL"}


def _policy(pid: int, tid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/task/{tid}/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[38])
    except (OSError, ValueError, IndexError):
        return None


def pipewire_loops() -> list[tuple[str, int, int]]:
    """(process name, pid, tid) of the audio threads (data-loop) of our PipeWire processes."""
    out = []
    uid = os.getuid()
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            if os.stat(f"/proc/{d}").st_uid != uid:
                continue
            with open(f"/proc/{d}/comm") as f:
                comm = f.read().strip()
            if comm not in ("pipewire", "pipewire-pulse"):
                continue
            for t in os.listdir(f"/proc/{d}/task"):
                with open(f"/proc/{d}/task/{t}/comm") as f:
                    if f.read().startswith("data-loop"):
                        out.append((comm, int(d), int(t)))
        except OSError:
            continue
    return out


def rt_summary() -> str:
    """e.g. "pipewire RR, pipewire-pulse RR" (one entry per audio thread)."""
    return ", ".join(f"{c}/{p} {SCHED.get(_policy(p, t), '?')}" for c, p, t in pipewire_loops()) or "-"


def pipewire_realtime():
    """PipeWire's audio threads should run SCHED_RR/FIFO (module-rt). When they
    run at normal priority (TS) a busy CPU (the video call's software H.264)
    delays them: the USB microphone overran 65-85 times and the speaker resynced
    49-68 times in 30 s of load, 0 and 0 with them realtime (2026-10-09, module-rt
    had failed through xdg-desktop-portal). Ask RTKit for what module-rt would
    have got. Only our own processes; nothing changes once PipeWire restarts.
    ZCALL_PW_RT=0: only report."""
    loops = pipewire_loops()
    low = [(c, p, t) for c, p, t in loops if _policy(p, t) == 0]
    if not low:
        log(f"realtime: {rt_summary()}")
        return
    if os.environ.get("ZCALL_PW_RT", "1") == "0" or not shutil.which("busctl"):
        log(f"realtime: PipeWire audio at normal priority ({rt_summary()}); expect crackle when the CPU is busy")
        return
    bus = ["busctl", "--system"]
    rtkit = ["org.freedesktop.RealtimeKit1", "/org/freedesktop/RealtimeKit1", "org.freedesktop.RealtimeKit1"]
    prio = 20
    try:
        r = subprocess.run([*bus, "get-property", *rtkit, "MaxRealtimePriority"], capture_output=True, text=True, timeout=3)
        prio = int(r.stdout.split()[1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        pass
    for c, p, t in low:
        try:
            r = subprocess.run([*bus, "call", *rtkit, "MakeThreadRealtimeWithPID", "ttu", str(p), str(t), str(prio)],
                               capture_output=True, text=True, timeout=3)
            if r.returncode:
                log(f"realtime: RTKit refused {c}/{p} thread {t}: {r.stderr.strip()}")
        except (OSError, subprocess.SubprocessError) as e:
            log(f"realtime: RTKit unavailable: {e}")
            break
    log(f"realtime: PipeWire audio was at normal priority, asked RTKit for RR {prio}: now {rt_summary()}")


class Processing:
    """WebRTC audio processing of PipeWire (module-echo-cancel) in a private
    pipewire process: a processed microphone source and a speaker sink (the
    echo reference) that exist as long as the process. The system's default
    devices stay as they are."""

    def __init__(self, high_pass=True):
        self.tag = f"zcall_ec_{os.getpid()}"
        self.source = self.tag + "_source"
        self.sink = self.tag + "_sink"
        self.high_pass = bool(high_pass)
        self.proc = None
        self.conf = None

    def start(self, mic: str | None, speaker: str | None) -> bool:
        """(Re)start on these devices (None: follow the default). False if it is not available."""
        self.stop()
        target = lambda n: f'target.object = "{n}" node.dont-reconnect = true' if n else ""  # noqa: E731
        conf = (EC_CONF.replace("@TAG@", self.tag).replace("@MIC@", target(mic))
                .replace("@SPEAKER@", target(speaker)).replace("@HPF@", "true" if self.high_pass else "false"))
        fd, self.conf = tempfile.mkstemp(prefix="zcall-ec-", suffix=".conf")
        with os.fdopen(fd, "w") as f:
            f.write(conf)
        try:
            self.proc = subprocess.Popen(["pipewire", "-c", self.conf], stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, preexec_fn=_die_with_parent)
        except OSError as e:
            log("audio processing unavailable:", e)
            self.stop()
            return False
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                break
            if self.source in pulse_names("sources") and self.sink in pulse_names("sinks"):
                log(f"audio processing on (mic {mic or 'default'}, speaker {speaker or 'default'})")
                return True
            time.sleep(0.05)
        log("audio processing did not start; using the devices directly")
        self.stop()
        return False

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None
        if self.conf:
            try:
                os.unlink(self.conf)
            except OSError:
                pass
            self.conf = None


class PulseOut:
    """Playback through libpulse-simple (PipeWire / PulseAudio). write() blocks
    until the stream has room, so the playout loop runs on the sound card's
    clock, as the real engine's AudioDeviceMac render thread pulls 10 ms at a
    time from NetEq. pacat could not do that: the pipe in front of it holds
    two seconds, so we had to guess the time with our own clock, and the
    card's clock drifts away from it (latency grows, or the card runs dry and
    clicks)."""

    LATENCY_MS = 60

    class _Spec(ctypes.Structure):
        _fields_ = [("format", ctypes.c_int), ("rate", ctypes.c_uint32), ("channels", ctypes.c_uint8)]

    class _Attr(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint32) for n in ("maxlength", "tlength", "prebuf", "minreq", "fragsize")]

    def __init__(self, device: str | None):
        lib = ctypes.CDLL("libpulse-simple.so.0")
        lib.pa_simple_new.restype = ctypes.c_void_p
        lib.pa_simple_new.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p,
                                      ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        lib.pa_simple_write.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_int)]
        lib.pa_simple_free.argtypes = [ctypes.c_void_p]
        lib.pa_simple_get_latency.restype = ctypes.c_uint64
        lib.pa_simple_get_latency.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        self.lib = lib
        self.lock = threading.Lock()
        self.s = self._open(device)
        self.silent = False
        self.failed = False

    def _open(self, device: str | None):
        spec = self._Spec(3, 16000, 1)  # PA_SAMPLE_S16LE
        none = 0xFFFFFFFF
        attr = self._Attr(none, FRAME_BYTES * self.LATENCY_MS // 20, none, none, none)
        err = ctypes.c_int(0)
        s = self.lib.pa_simple_new(None, b"Zalo", 1, device.encode() if device else None, b"Call",  # PA_STREAM_PLAYBACK
                                   ctypes.byref(spec), None, ctypes.byref(attr), ctypes.byref(err))
        if not s:
            raise OSError(f"pa_simple_new failed ({err.value})")
        log(f"player: libpulse-simple {device or 'default'}, {self.LATENCY_MS} ms")
        return s

    def switch(self, device: str | None):
        new = self._open(device)
        with self.lock:
            old, self.s = self.s, new
        self.lib.pa_simple_free(old)

    def write(self, pcm: bytes):
        if self.silent:
            pcm = bytes(len(pcm))
        with self.lock:
            err = ctypes.c_int(0)
            ok = self.s and self.lib.pa_simple_write(self.s, pcm, len(pcm), ctypes.byref(err)) >= 0
        if not ok:
            # The device went away (processing restarted for another device):
            # keep time until switch() brings a new stream.
            if not self.failed:
                log(f"pa_simple_write failed ({err.value})")
            self.failed = True
            time.sleep(0.02)
        else:
            self.failed = False

    def latency_ms(self) -> float | None:
        """Audio queued in front of the sound card now (ms)."""
        with self.lock:
            if not self.s:
                return None
            err = ctypes.c_int(0)
            us = self.lib.pa_simple_get_latency(self.s, ctypes.byref(err))
        return None if err.value else us / 1000

    def close(self):
        with self.lock:
            if self.s:
                self.lib.pa_simple_free(self.s)
                self.s = None


class _Stream:
    """One received stream (one SSRC), a small NetEq: packets wait undecoded
    and are decoded when the playout asks for the next 20 ms, so that
    - a packet not there yet when it is due is waited for with PLC (NetEq's
      Expand: a late packet still plays, the delay grows); once enough is
      buffered after it, it is lost and becomes Opus FEC (from the next
      packet) or PLC in its place, never a gap;
    - after MAX_EXPAND frames of PLC with nothing to play, it goes quiet and
      builds up the buffer again;
    - the buffer depth follows the measured arrival jitter (min..max frames);
      too much buffered (a burst, or the sender's clock faster than our card)
      drops a quiet frame now and then, like NetEq's Accelerate.
    """

    MIN_TARGET = 5        # 100 ms: zrtc_config minAudioDelayMs (macOS NetEq's floor)
    START_TARGET = 5      # until the jitter is measured
    MAX_EXPAND = 5        # 100 ms of PLC before going quiet
    WINDOW = 250          # arrivals (5 s) used for the jitter estimate

    def __init__(self, opus, max_target: int, stats: Counter, min_target: int | None = None):
        self.opus = opus
        self.dec = new_decoder(opus)
        self.buf = ctypes.create_string_buffer(1920 * 2)
        self.min_target = max(2, min_target or self.MIN_TARGET)
        self.max_target = max(self.min_target, max_target)
        self.stats = stats
        self.packets = {}     # idx -> Opus payload
        self.next = None      # idx played next
        self.playing = False
        self.expand = 0       # PLC frames in a row
        self.carry = b""      # rest of a packet longer than 20 ms
        self.transit = deque(maxlen=self.WINDOW)
        self.target = max(self.START_TARGET, self.min_target)
        self.last = time.monotonic()
        self.since_drop = 0

    def push(self, idx: int, payload: bytes, now: float):
        self.last = now
        if self.next is not None and idx < self.next:
            self.stats["late"] += 1
            return
        if idx in self.packets:
            self.stats["dup"] += 1
            return
        self.packets[idx] = payload
        # Arrival time minus send time (idx * 20 ms) up to a constant: its
        # spread over the last seconds is the jitter the buffer must absorb.
        self.transit.append(now - idx * 0.02)
        if len(self.transit) >= 20:
            t = sorted(self.transit)
            spread = t[int(len(t) * 0.95) - 1] - t[0]
            self.target = min(self.max_target, max(self.min_target, math.ceil(spread / 0.02) + 1))

    def _decode(self, payload, fec=False) -> bytes:
        size = FRAME if fec or not payload else 1920
        n = self.opus.opus_decode(self.dec, payload, len(payload) if payload else 0, self.buf, size, 1 if fec else 0)
        if n <= 0:
            self.stats["opus_fail"] += 1
            return bytes(FRAME_BYTES)
        return self.buf.raw[:n * 2]

    def _take(self, pcm: bytes) -> bytes:
        self.carry = pcm[FRAME_BYTES:]
        return pcm[:FRAME_BYTES].ljust(FRAME_BYTES, b"\0")

    def pull(self) -> bytes | None:
        """The next 20 ms, or None (not playing)."""
        if self.carry:
            return self._take(self.carry)
        if not self.playing:
            if len(self.packets) < self.target:
                return None
            self.playing = True
            first = min(self.packets)
            if self.next is None or first > self.next:
                self.next = first
        self.since_drop += 1
        if self.next in self.packets:
            pcm = self._decode(self.packets.pop(self.next))
            self.next += 1
            self.expand = 0
            self.stats["opus_ok"] += 1
            span = max(self.packets) - self.next + 1 if self.packets else 0
            # Too much buffered: drop this frame if it is quiet, or any frame
            # when far too much (after a stall). At most one per 200 ms. The
            # next frame fades in over the dropped one's first 5 ms, so the
            # wave goes on from what was played: no click where 20 ms are cut
            # (macOS NetEq time-stretches instead, webrtc::Accelerate).
            if span > self.target + 2 and self.since_drop >= 10 and self.next in self.packets \
                    and (span > self.target + 8 or _rms(pcm) < 300):
                self.since_drop = 0
                self.stats["accelerate"] += 1
                if _rms(pcm) >= 300:
                    self.stats["accelerate_loud"] += 1
                nxt = self.pull()
                return _crossfade(pcm[:FRAME_BYTES], nxt) if nxt else self._take(pcm)
            return self._take(pcm)
        if self.packets and (len(self.packets) >= self.target or self.expand >= self.MAX_EXPAND):
            # A hole, and the buffer waited long enough: the packet is lost.
            self.expand = 0
            self.stats["lost"] += 1
            nxt = self.packets.get(self.next + 1)
            self.next += 1
            if nxt is not None:
                self.stats["fec"] += 1
                return self._take(self._decode(nxt, fec=True))
            self.stats["plc"] += 1
            return self._take(self._decode(None))
        # Not there yet: conceal and wait for it (the delay grows by 20 ms;
        # Accelerate takes it back later), then go quiet and buffer up again.
        self.stats["underrun"] += 1
        if self.expand < self.MAX_EXPAND:
            self.expand += 1
            self.stats["plc"] += 1
            return self._take(self._decode(None))
        self.expand = 0
        self.playing = False
        return None


XFADE = 80  # samples (5 ms)


def _crossfade(a: bytes, b: bytes) -> bytes:
    """b, with its first XFADE samples faded in over a's."""
    x, y = array("h", a), array("h", b)
    n = min(XFADE, len(x), len(y))
    for i in range(n):
        w = (i + 1) / (n + 1)
        y[i] = int(x[i] * (1 - w) + y[i] * w)
    return y.tobytes()


def _rms(pcm: bytes) -> float:
    a = array("h", pcm)
    return math.sqrt(sum(v * v for v in a) / len(a)) if a else 0.0


class Playout:
    """Every 20 ms, the next frame of each source (_Stream), summed, as the
    real engine's OutputMixer + NetEq do (one source in a 1-1 call). With
    PulseOut the loop is paced by the sound card (blocking writes); with
    another sink (pacat, aplay, a file) by our own clock."""

    IDLE_SEC = 5    # a source that sent nothing for this long is forgotten
    REPORT_SEC = 30

    def __init__(self, sink, depth: int = 10, min_delay_ms: int = 100):
        self.sink = sink
        self.depth = depth
        self.min_target = max(2, math.ceil(min_delay_ms / 20))
        # For the diag line: card stream fill (ms) and the slowest mix, per period.
        self.dev_min = self.dev_max = None
        self.mix_max = 0.0
        self.opus = load_opus()
        self.sources = {}  # src -> _Stream
        self.lock = threading.Lock()
        self.stats = Counter()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._clock, daemon=True)
        self.thread.start()

    def push(self, idx: int, payload: bytes, source=None):
        now = time.monotonic()
        with self.lock:
            s = self.sources.get(source)
            if s is None:
                s = self.sources[source] = _Stream(self.opus, self.depth, self.stats, self.min_target)
                log(f"playout: new source {source} (buffer {s.target * 20}..{s.max_target * 20} ms)")
            s.push(idx, payload, now)

    def _mix(self):
        now = time.monotonic()
        out = None
        with self.lock:
            for src in list(self.sources):
                s = self.sources[src]
                if now - s.last > self.IDLE_SEC and not s.packets:
                    del self.sources[src]
                    log(f"playout: source {src} gone")
                    continue
                pcm = s.pull()
                if pcm is None:
                    continue
                frame = array("h", pcm)
                if out is None:
                    out = frame
                else:
                    for i in range(FRAME):
                        v = out[i] + frame[i]
                        out[i] = 32767 if v > 32767 else -32768 if v < -32768 else v
        self.stats["mixed"] += 1
        return out.tobytes() if out is not None else bytes(FRAME_BYTES)

    def _report(self):
        with self.lock:
            targets = {src: s.target * 20 for src, s in self.sources.items()}
        keys = ("opus_ok", "lost", "fec", "plc", "underrun", "accelerate", "late")
        log("playout:", {k: self.stats[k] for k in keys if self.stats[k]}, "buffer ms", targets)

    def _clock(self):
        paced = isinstance(self.sink, PulseOut)
        nxt = last_report = time.monotonic()
        latency = getattr(self.sink, "latency_ms", None)
        while not self.stop.is_set():
            t = time.monotonic()
            pcm = self._mix()
            DUMP.write("played", pcm)
            self.mix_max = max(self.mix_max, time.monotonic() - t)
            if latency:
                ms = latency()
                if ms is not None:
                    self.dev_min = ms if self.dev_min is None else min(self.dev_min, ms)
                    self.dev_max = ms if self.dev_max is None else max(self.dev_max, ms)
            try:
                self.sink.write(pcm)
            except (BrokenPipeError, ValueError, OSError) as e:
                log("playout stopped:", e)
                return
            now = time.monotonic()
            if now - last_report >= self.REPORT_SEC:
                last_report = now
                self._report()
            if paced:
                continue
            nxt += 0.02
            delay = nxt - now
            if delay > 0:
                time.sleep(delay)
            elif delay < -0.2:
                nxt = time.monotonic()  # fell behind (suspend, load): start over

    def flush(self):
        self.stop.set()
        self.thread.join(timeout=1)
        with self.lock:
            self.sources.clear()


Mixer = Playout  # older name (tests)


class Diag:
    """One "diag:" log line every DIAG_SEC during the call, for the test calls:
    the playout counters of the period, the card stream's fill, the microphone's
    longest gap, and what PipeWire saw: the quantum of the graph, new overruns
    (pw-top ERR) of the nodes we use, and speaker resyncs in its journal."""

    DIAG_SEC = 10
    KEYS = ("opus_ok", "lost", "fec", "plc", "underrun", "accelerate", "accelerate_loud", "late", "dup")

    def __init__(self, playout: "Playout", mic: "Mic | None", tag: str):
        self.playout, self.mic, self.tag = playout, mic, tag
        self.prev_stats = Counter()
        self.prev_err = {}
        self.since = time.time()
        self.pw = bool(shutil.which("pw-top"))
        self.journal = bool(shutil.which("journalctl"))
        threading.Thread(target=self._run, daemon=True).start()

    def _pw(self):
        """Running nodes of the last pw-top snapshot: name -> (quant, rate, err, driver)."""
        try:
            out = subprocess.run(["pw-top", "-b", "-n", "2"], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            return {}
        last = out.split("S   ID")[-1].splitlines()[1:]
        nodes = {}
        for line in last:
            c = line.split()
            if len(c) < 10 or c[0] != "R":
                continue
            name = c[-1]
            follower = "+" in c[9:]
            try:
                nodes[name] = (int(c[2]), int(c[3]), int(c[8]), not follower)
            except ValueError:
                continue
        return nodes

    def _resyncs(self, since: float) -> int:
        if not self.journal:
            return -1
        try:
            out = subprocess.run(["journalctl", "--user", "-u", "pipewire", "--since", f"@{int(since)}", "-o", "cat", "--no-pager"],
                                 capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            return -1
        n = 0
        for line in out.splitlines():
            if "resync" in line:
                n += 1
                if "suppressed" in line:
                    try:
                        n += int(line.rsplit("(", 1)[1].split()[0])
                    except (IndexError, ValueError):
                        pass
        return n

    def _run(self):
        while not self.playout.stop.is_set():
            self.playout.stop.wait(self.DIAG_SEC)
            if self.playout.stop.is_set():
                return
            p = self.playout
            st = Counter(p.stats)
            d = {k: st[k] - self.prev_stats[k] for k in self.KEYS if st[k] - self.prev_stats[k]}
            self.prev_stats = st
            with p.lock:
                buf = {src: s.target * 20 for src, s in p.sources.items()}
            dev = f"{p.dev_min:.0f}..{p.dev_max:.0f}" if p.dev_min is not None else "-"
            mix = p.mix_max * 1000
            p.dev_min = p.dev_max = None
            p.mix_max = 0.0
            mic = "-"
            if self.mic:
                mic = f"max gap {self.mic.gap_max * 1000:.0f} ms, stalls {self.mic.gaps}"
                self.mic.gap_max, self.mic.gaps = 0.0, 0
                g = getattr(self.mic, "guard", None)
                if g:
                    mic += f", {g.report()}, gain steps {g.steps}"
            pw = ""
            if self.pw:
                nodes = self._pw()
                ours = {n: v for n, v in nodes.items() if n.startswith(("alsa_", "bluez_", self.tag)) or n in ("Zalo", "parec")}
                drivers = [f"{n} q{v[0]}" for n, v in ours.items() if v[3]]
                xr = []
                for n, v in ours.items():
                    if n.startswith(("alsa_", "bluez_")):
                        if n in self.prev_err and v[2] > self.prev_err[n]:
                            xr.append(f"{n.split('.')[0]}.{n.split('.')[-1]} +{v[2] - self.prev_err[n]}")
                        self.prev_err[n] = v[2]
                pw = f"; pipewire driver {', '.join(drivers) or '-'}, xruns {', '.join(xr) or '0'}"
            now = time.time()
            rs = self._resyncs(self.since)
            self.since = now
            log(f"diag: playout {d or '{}'}, buffer ms {buf}, card queue ms {dev}, mix max {mix:.1f} ms; mic {mic}{pw}"
                + (f", resyncs {rs}" if rs >= 0 else "") + f"; rt {rt_summary()}")


class ClipGuard:
    """Turns the microphone's PulseAudio source down when its speech clips, as
    the real engine's analog AGC does (AgcManagerDirect turns the OS microphone
    volume; zrtc_config audioGainControl true, agcMaxLevel 200). A USB headset
    at its 0 dB maximum clipped hard: 12233 samples at full scale, 563 frames
    over -6 dBFS in a 41 s 1-1 call (dump 2026-10-10); the phone heard it
    distorted, and its own echo canceller then cut its voice (12 of 13 silent
    holes in what it sent came right after our clipping). Only down, 3 dB a
    step, at most once per STEP_SEC, never below FLOOR_DB; the level stays for
    the next calls, as with Zalo on Windows / macOS. ZCALL_MIC_AGC=0: off."""

    WINDOW = 10          # frames (200 ms) per decision
    CLIP = 31000         # |sample| counted as clipped (after resampling a full-scale flat top)
    MIN_CLIPPED = 16     # clipped samples per window (0.5 %) that trigger a step
    STEP_DB = 3.0
    STEP_SEC = 0.6
    FLOOR_DB = -24.0

    def __init__(self, source: str | None):
        self.source = source
        self.on = bool(source) and os.environ.get("ZCALL_MIC_AGC", "1") != "0" and bool(shutil.which("pactl"))
        self.frames = self.clipped = 0
        self.last_step = 0.0
        self.busy = False
        self.total_clipped = 0  # for the diag line
        self.peak = 0
        self.steps = 0
        if source:
            log(f"mic gain guard {'on' if self.on else 'off'} for {source} (now {self._db()} dB)")

    def set_source(self, source: str | None):
        self.source = source
        self.on = bool(source) and os.environ.get("ZCALL_MIC_AGC", "1") != "0" and bool(shutil.which("pactl"))

    def _db(self):
        try:
            out = subprocess.run(["pactl", "get-source-volume", self.source], capture_output=True, text=True, timeout=3,
                                 env={**os.environ, "LC_ALL": "C"}).stdout
            return float(out.split(" dB")[0].rsplit("/", 1)[1])
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            return None

    def feed(self, pcm: bytes):
        a = array("h", pcm)
        n = sum(1 for v in a if v >= self.CLIP or v <= -self.CLIP)
        self.clipped += n
        self.total_clipped += n
        if a:
            self.peak = max(self.peak, max(a), -min(a))
        self.frames += 1
        if self.frames < self.WINDOW:
            return
        clipped, self.frames, self.clipped = self.clipped, 0, 0
        now = time.monotonic()
        if self.on and not self.busy and clipped >= self.MIN_CLIPPED and now - self.last_step >= self.STEP_SEC:
            self.last_step = now
            self.busy = True
            threading.Thread(target=self._step, args=(clipped,), daemon=True).start()

    def _step(self, clipped):
        try:
            cur = self._db()
            if cur is None or cur <= self.FLOOR_DB + 0.01:
                return
            new = max(self.FLOOR_DB, cur - self.STEP_DB)
            # Raw volume (PulseAudio's cubic scale: dB = 60 log10(v / 65536)); pactl
            # misreads "-6.0dB" (it set -9 dB, and "-9.0dB" -18 dB, 2026-10-10).
            raw = int(round(65536 * 10 ** (new / 60)))
            subprocess.run(["pactl", "set-source-volume", self.source, str(raw)], capture_output=True, timeout=3)
            self.steps += 1
            log(f"mic gain guard: {clipped} clipped samples in 200 ms, {self.source} {cur:.1f} -> {self._db()} dB")
        except (OSError, subprocess.SubprocessError) as e:
            log("mic gain guard:", e)
        finally:
            self.busy = False

    def report(self) -> str:
        r = f"clipped {self.total_clipped}, peak {20 * math.log10(max(self.peak, 1) / 32768):.1f} dBFS"
        self.total_clipped = 0
        self.peak = 0
        return r


class Dump:
    """ZCALL_AUDIO_DUMP=1: raw PCM of the call (see the module doc)."""

    def __init__(self):
        self.played = self.mic = None
        if os.environ.get("ZCALL_AUDIO_DUMP") != "1":
            return
        d = Path(os.environ.get("ZCALL_LOG_DIR") or tempfile.gettempdir())
        stem = d / time.strftime("call-%Y%m%d-%H%M%S")
        try:
            self.played = open(f"{stem}-played.raw", "wb")
            self.mic = open(f"{stem}-mic.raw", "wb")
            log(f"dump: {stem}-played.raw / -mic.raw (16 kHz mono s16le)")
        except OSError as e:
            log("dump unavailable:", e)

    def write(self, which, pcm: bytes):
        f = getattr(self, which)
        if f:
            try:
                f.write(pcm)
            except (OSError, ValueError):
                pass


DUMP = Dump()


def read_exact(fh, n: int) -> bytes | None:
    out = bytearray()
    while len(out) < n:
        chunk = fh.read(n - len(out))
        if not chunk:
            return None
        out += chunk
    return bytes(out)


def audio_level(pcm: bytes) -> int:
    """RFC 6464 level of a frame: -dBov, 0 (full scale) .. 127 (silence).
    The macOS client's group audio says 41..46 for speech (capture 2026-10-08)."""
    a = array("h", pcm)
    if not a:
        return 127
    rms = math.sqrt(sum(v * v for v in a) / len(a))
    if rms < 1:
        return 127
    return min(127, max(0, int(round(-20 * math.log10(rms / 32768)))))


def encoder_loop(args, opus, muted, out, lock, mic, guard=None):
    err = ctypes.c_int(0)
    enc = opus.opus_encoder_create(16000, 1, OPUS_APPLICATION_VOIP, ctypes.byref(err))
    if err.value != 0 or not enc:
        log("opus_encoder_create failed", err.value)
        return
    opus.opus_encoder_ctl(enc, OPUS_SET_BITRATE, args.bitrate)
    opus.opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY, args.complexity)
    opus.opus_encoder_ctl(enc, OPUS_SET_SIGNAL, OPUS_SIGNAL_VOICE)
    # In-band FEC is the 1-1 default. A group zrtcConfig with audioFecInband
    # false passes --no-fec: those bits would otherwise eat the 20 kbps frame.
    fec = 0 if args.no_fec else 1
    opus.opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC, fec)
    opus.opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC, 0 if args.no_fec else args.loss)
    log(f"encode {args.bitrate} bps complexity {args.complexity} fec {fec} high-pass {not args.no_high_pass}")
    buf = ctypes.create_string_buffer(1500)
    silence = bytes(FRAME_BYTES)

    if args.tone:
        import time
        phase = 0
        start = time.monotonic()
        n = 0
        def frames():
            nonlocal phase, n
            while True:
                pcm = bytearray()
                for _ in range(FRAME):
                    pcm += struct.pack("<h", int(8000 * math.sin(phase)))
                    phase += 2 * math.pi * 440 / 16000
                n += 1
                delay = start + n * 0.02 - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                yield bytes(pcm)
        source = frames()
    else:
        source = mic.frames()

    sent = 0
    for pcm in source:
        frame = silence if muted.is_set() else pcm
        DUMP.write("mic", frame)
        if guard and frame is pcm:
            guard.feed(pcm)
        size = opus.opus_encode(enc, frame, FRAME, buf, len(buf))
        if size <= 0:
            continue
        level = audio_level(frame)
        with lock:
            try:
                out.write(b"L" + struct.pack(">BH", level, size) + buf.raw[:size])
                out.flush()
            except (BrokenPipeError, ValueError):
                return
        sent += 1
        if sent == 1:
            log("first microphone frame encoded")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # 1-1 default. A group call passes zrtcConfig.audioBitrate (kbps * 1000) instead.
    ap.add_argument("--bitrate", type=int, default=32000)
    ap.add_argument("--complexity", type=int, default=10)
    ap.add_argument("--loss", type=int, default=5, help="expected packet loss %% (Opus FEC)")
    ap.add_argument("--no-fec", action="store_true", help="audioFecInband false: FEC off, expected loss 0")
    ap.add_argument("--no-high-pass", action="store_true", help="audioHighPassFilter false")
    ap.add_argument("--jitter", type=int, default=10, help="jitter buffer depth in 20 ms frames")
    ap.add_argument("--min-delay", type=int, default=100, help="least jitter buffer depth in ms (minAudioDelayMs)")
    ap.add_argument("--device", help="ALSA device (default: PulseAudio if running)")
    ap.add_argument("--out", type=Path, help="write received audio to this file instead of playing")
    ap.add_argument("--tone", action="store_true", help="send a 440 Hz tone instead of the microphone")
    ap.add_argument("--mix", action="store_true", help="group call: decode every source and mix them")
    ap.add_argument("--no-mic", action="store_true", help="receive only")
    ap.add_argument("--mic", default=os.environ.get("ZCALL_MIC"), help="PulseAudio source")
    ap.add_argument("--speaker", default=os.environ.get("ZCALL_SPEAKER"), help="PulseAudio sink")
    args = ap.parse_args()

    opus = load_opus()
    pulse = args.out is None and args.device is None and pulse_running()
    # The devices picked (None: the default); with processing, what it is attached to.
    chosen = {"mic": present(args.mic, "sources") if pulse else None,
              "speaker": present(args.speaker, "sinks") if pulse else None}
    proc = Processing(high_pass=not args.no_high_pass) if pulse and os.environ.get("ZCALL_AUDIO_PROCESSING", "1") != "0" else None

    def start_processing() -> bool:
        return proc.start(chosen["mic"] or pulse_mic(), chosen["speaker"]) if proc else False

    processed = start_processing()
    if pulse:
        threading.Thread(target=pipewire_realtime, daemon=True).start()
    speaker_name = proc.sink if processed else chosen["speaker"]
    sink = None
    if pulse:
        try:
            sink = PulseOut(speaker_name)
        except OSError as e:
            log("libpulse-simple unavailable, using pacat:", e)
    if sink is None:
        player = " ".join(shlex.quote(a) for a in speaker_command(speaker_name)) if pulse else None
        sink = Sink(args.out, player, args.device)
    # 1-1 and group calls alike (--mix only says several sources are expected).
    jitter = Playout(sink, depth=args.jitter, min_delay_ms=args.min_delay)
    muted = threading.Event()
    out = os.fdopen(sys.stdout.fileno(), "wb", buffering=0)
    lock = threading.Lock()
    mic = None
    if not args.no_mic:
        mic = None if args.tone else Mic(args.device, proc.source if processed else chosen["mic"])
        if pulse and mic:
            guard = ClipGuard(chosen["mic"] or pulse_mic() or default_source())
            mic.guard = guard
        threading.Thread(target=encoder_loop, args=(args, opus, muted, out, lock, mic, getattr(mic, "guard", None)), daemon=True).start()
    if pulse and os.environ.get("ZCALL_AUDIO_DIAG", "1") != "0":
        Diag(jitter, mic, proc.tag if proc else "zcall_ec_")

    inp = os.fdopen(sys.stdin.fileno(), "rb", buffering=0)
    try:
        while True:
            kind = inp.read(1)
            if not kind:
                break
            if kind == b"F":
                hdr = read_exact(inp, 10)
                if hdr is None:
                    break
                idx, src, n = struct.unpack(">IIH", hdr)
                payload = read_exact(inp, n)
                if payload is None:
                    break
                jitter.push(idx, payload, src)
            elif kind == b"S":
                on = read_exact(inp, 1)
                if on is None:
                    break
                sink.silent = bool(on[0])
                log("speaker off" if on[0] else "speaker on")
            elif kind == b"M":
                on = read_exact(inp, 1)
                if on is None:
                    break
                (muted.set if on[0] else muted.clear)()
                log("mute" if on[0] else "unmute")
            elif kind == b"D":
                hdr = read_exact(inp, 3)
                if hdr is None:
                    break
                which, n = hdr[0], struct.unpack(">H", hdr[1:])[0]
                name = read_exact(inp, n) if n else b""
                if name is None:
                    break
                name = name.decode("utf-8", "replace") or None
                if not pulse or which not in (ord("i"), ord("o")):
                    continue
                if which == ord("i"):
                    chosen["mic"] = present(name, "sources")
                    if mic and getattr(mic, "guard", None):
                        mic.guard.set_source(chosen["mic"] or pulse_mic() or default_source())
                else:
                    chosen["speaker"] = present(name, "sinks")
                if processed:
                    # Re-attach the processing; its devices come back under the same names.
                    processed = start_processing()
                    if mic:
                        mic.switch(proc.source if processed else chosen["mic"])
                    switch_speaker(sink, proc.sink if processed else chosen["speaker"])
                elif which == ord("i") and mic:
                    mic.switch(chosen["mic"])
                elif which == ord("o"):
                    switch_speaker(sink, chosen["speaker"])
            else:
                log("bad frame kind", kind)
                break
    finally:
        jitter.flush()
        sink.close()
        if proc:
            proc.stop()
        log("stats", dict(jitter.stats))


if __name__ == "__main__":
    main()
