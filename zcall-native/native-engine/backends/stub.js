'use strict';
// Media backend that does no media (--media stub): signalling and the call
// window only, a call connects without audio or video. For tests.
const { MediaBackend } = require('../engine-core');

class StubMedia extends MediaBackend {
  constructor(log = console.error) { super(); this.log = log; }
  onNegotiated(params) {
    const n = params.servers ? params.servers.length : 0;
    this.log(`[media/stub] negotiated: ${n} server(s), srtpMode=${params.srtpMode}, codec=${(params.codec || '').trim()} — no media sent (stub)`);
  }
  prepare() { return Promise.resolve(null); }
  start(role) { this.log(`[media/stub] start (${role}) — silent: no RTP backend`); }
  stop() { this.log('[media/stub] stop'); }
}

module.exports = { StubMedia };
