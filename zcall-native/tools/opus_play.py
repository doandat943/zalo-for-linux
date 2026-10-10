"""Opus 16 kHz mono playback with a jitter buffer, shared by
tools/live-downlink-audio.py and native-engine/audio-io.py.

Sink: pacat when PulseAudio/PipeWire runs (it owns the card during a call),
else aplay on the USB headset, or a .wav / raw file.
OpusJitter: reorder by extended sequence number, Opus PLC for gaps.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import shlex
import subprocess
import sys
import wave
from collections import Counter
from pathlib import Path

FRAME = 320  # 20 ms at 16 kHz
DEFAULT_DEVICE = "plughw:1,0"  # USB headset on Máy-120; see docs/fix-log/2026-09-29-aplay-usb.md


def load_opus():
    # find_library needs ldconfig or a compiler; the loader finds libopus.so.0
    # on its own in the standard paths of any distro / architecture.
    lib = ctypes.util.find_library("opus") or "libopus.so.0"
    opus = ctypes.CDLL(lib)
    opus.opus_decoder_create.restype = ctypes.c_void_p
    opus.opus_decoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    opus.opus_decode.argtypes = [
        ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_int,
    ]
    opus.opus_encoder_create.restype = ctypes.c_void_p
    opus.opus_encoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    opus.opus_encode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    opus.opus_encoder_ctl.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    return opus


def new_decoder(opus):
    err = ctypes.c_int(0)
    dec = opus.opus_decoder_create(16000, 1, ctypes.byref(err))
    if err.value != 0 or not dec:
        raise RuntimeError("opus_decoder_create failed")
    return dec


def pulse_running() -> bool:
    try:
        return subprocess.run(["pactl", "info"], capture_output=True, timeout=3).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class Sink:
    def __init__(self, out: Path | None = None, player: str | None = None, device: str | None = None):
        self.proc = None
        self.wav = None
        self.raw = None
        if out is not None:
            if out.suffix == ".wav":
                self.wav = wave.open(str(out), "wb")
                self.wav.setnchannels(1)
                self.wav.setsampwidth(2)
                self.wav.setframerate(16000)
            else:
                self.raw = out.open("wb")
            return
        if player:
            cmd = shlex.split(player)
        elif device is None and pulse_running():
            # PipeWire owns the card during a call, so aplay on hw would be busy.
            cmd = ["pacat", "--raw", "--rate=16000", "--channels=1", "--format=s16le", "--latency-msec=60"]
        else:
            cmd = ["aplay", "-q", "-D", device or DEFAULT_DEVICE, "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1"]
        print("player:", " ".join(cmd), file=sys.stderr)
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    silent = False  # play silence instead (call speaker off), keeps timing

    def write(self, pcm: bytes):
        if self.silent:
            pcm = bytes(len(pcm))
        if self.wav:
            self.wav.writeframes(pcm)
        elif self.raw:
            self.raw.write(pcm)
        else:
            self.proc.stdin.write(pcm)
            self.proc.stdin.flush()

    def close(self):
        if self.wav:
            self.wav.close()
        if self.raw:
            self.raw.close()
        if self.proc:
            try:
                self.proc.stdin.close()
            except BrokenPipeError:
                pass
            self.proc.wait()


class OpusJitter:
    """Jitter buffer + Opus decode. P2P audio arrives up to ~20 frames out of
    order; frames still missing when the buffer is deeper than `depth` become
    PLC (up to `max_plc` per gap). Later arrivals and duplicates are dropped."""

    def __init__(self, sink: Sink, max_plc: int = 5, depth: int = 10):
        self.sink = sink
        self.max_plc = max_plc
        self.depth = depth
        self.opus = load_opus()
        self.dec = new_decoder(self.opus)
        self.buf = ctypes.create_string_buffer(1920 * 2)
        self.jb = {}  # extended seq -> Opus payload
        self.source = None  # ssrc (or any stream key); a change flushes
        self.next = None  # extended seq expected next
        self.stats = Counter()

    def _decode(self, payload, fec=False):
        # PLC (payload None) and FEC must ask for exactly one 20 ms frame: with
        # the 1920-sample maximum, libopus conceals 120 ms per lost packet.
        size = FRAME if fec or not payload else 1920
        n = self.opus.opus_decode(self.dec, payload, len(payload) if payload else 0, self.buf, size, 1 if fec else 0)
        if n > 0:
            self.sink.write(self.buf.raw[: n * 2])
        return n

    def _drain(self, depth: int):
        # Play the oldest frame once it is the one expected, or once the
        # buffer is deeper than `depth` (then whatever is missing is lost).
        while self.jb:
            lo = min(self.jb)
            if self.next is not None and lo != self.next and len(self.jb) <= depth:
                return
            if self.next is not None and lo > self.next:
                lost = lo - self.next
                self.stats["lost"] += lost
                n = min(lost, self.max_plc)
                for i in range(n):
                    # The frame right before `lo` can come back from lo's
                    # in-band FEC (if the sender added it; else this is PLC too).
                    if i == n - 1 and lost <= self.max_plc:
                        if self._decode(self.jb[lo], fec=True) > 0:
                            self.stats["fec"] += 1
                    elif self._decode(None) > 0:
                        self.stats["plc"] += 1
            self.next = lo + 1
            if self._decode(self.jb.pop(lo)) > 0:
                self.stats["opus_ok"] += 1
            else:
                self.stats["opus_fail"] += 1

    def flush(self):
        self._drain(0)
        self.source = None
        self.next = None

    def push(self, idx: int, payload: bytes, source=None):
        if source != self.source:
            self.flush()
            self.source = source
        if (self.next is not None and idx < self.next) or idx in self.jb:
            self.stats["late"] += 1
            return
        self.jb[idx] = payload
        self._drain(self.depth)
