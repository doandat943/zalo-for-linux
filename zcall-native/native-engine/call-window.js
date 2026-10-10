'use strict';
// Minimal call window for the native engine, in place of ZaloCall's Qt window:
// a zenity progress dialog with the call status and an "end call" button.
// The real engine owns hang-up (every 409/405 in the captures comes from it),
// so pressing the button is what ends the call.

const { spawn } = require('child_process');

class CallWindow {
  constructor(log = () => {}) {
    this.log = log;
    this.proc = null;
    this.hangupCb = () => {};
    this.timer = null;
  }

  onHangup(cb) { this.hangupCb = cb; }

  open({ title, text, notice = false }) {
    this._kill();
    const args = notice
      ? ['--notification', `--text=${text}`]
      : ['--progress', '--pulsate', `--title=Zalo — ${title}`, `--text=${text}`,
        '--cancel-label=Kết thúc', '--width=360'];
    let proc;
    try {
      proc = spawn('zenity', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (e) {
      this.log('call window: zenity not available', e.message);
      return;
    }
    proc.on('error', (e) => this.log('call window:', e.message));
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // closed by us
      this.proc = null;
      clearInterval(this.timer);
      // 1 = "Kết thúc" pressed or window closed. Anything else is zenity
      // failing (e.g. 255 for an unknown option): keep the call going.
      if (code === 1 && !notice) this.hangupCb();
      else if (code !== 0) this.log('call window: zenity exited', code);
    });
    this.proc = proc;
  }

  // Incoming call: "Nghe" / "Từ chối". Exactly one of the callbacks runs,
  // unless close() is called first (the caller gave up).
  incoming({ title, text, timeoutSec = 60 }, onAccept, onReject) {
    this._kill();
    let proc;
    try {
      proc = spawn('zenity', ['--question', `--title=Zalo — ${title}`, `--text=${text}`, '--ok-label=Nghe',
        '--cancel-label=Từ chối', `--timeout=${timeoutSec}`, '--width=360'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (e) {
      this.log('call window: zenity not available', e.message);
      return;
    }
    proc.on('error', (e) => this.log('call window:', e.message));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // closed by us
      this.proc = null;
      if (code === 0) onAccept();
      else if (code === 1 || code === 5) onReject(code === 5 ? 'timeout' : 'reject'); // 5 = --timeout
      else { this.log('call window: zenity exited', code); onReject('ui-error'); }
    });
    this.proc = proc;
  }

  // Update the status line; with `since`, show a running call timer.
  status(text, since = 0) {
    clearInterval(this.timer);
    const write = () => {
      if (!this.proc) return;
      let line = text;
      if (since) {
        const s = Math.floor((Date.now() - since) / 1000);
        line += ` — ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }
      try { this.proc.stdin.write(`# ${line}\n`); } catch (_) {}
    };
    write();
    if (since) this.timer = setInterval(write, 1000);
  }

  close(text) {
    if (text) this.log('call window:', text);
    this._kill();
  }

  _kill() {
    clearInterval(this.timer);
    const p = this.proc;
    this.proc = null;
    if (p) try { p.kill(); } catch (_) {}
  }
}

module.exports = { CallWindow };
