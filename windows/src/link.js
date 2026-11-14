'use strict';
// The secure line protocol shared with the Mac, iPhone and Android apps (see docs/PROTOCOL.md).
// Newline-delimited lines over TCP. The server sends {"challenge"}, the client answers {"proof"} (HMAC of the
// QR-shared secret), then every line is a base64 AES-256-GCM record of {"sequence", "packet"} under
// HKDF-derived direction keys. Sequence numbers reject replays and reordering.
const crypto = require('crypto');

const PROOF_LABEL = Buffer.from('bluey-pair-v1');
const MAX_BUFFER = 16 * 1024 * 1024;

function deriveKey(secret, challenge, direction) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, challenge, Buffer.from('bluey-v1-' + direction), 32));
}

function proof(secret, challenge) {
  return crypto.createHmac('sha256', secret).update(Buffer.concat([PROOF_LABEL, challenge])).digest();
}

function verifies(candidate, secret, challenge) {
  const expected = proof(secret, challenge);
  return Buffer.isBuffer(candidate) && candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

class SecureChannel {
  constructor(secret, challenge, server) {
    this.sendKey = deriveKey(secret, challenge, server ? 'mac-to-phone' : 'phone-to-mac');
    this.receiveKey = deriveKey(secret, challenge, server ? 'phone-to-mac' : 'mac-to-phone');
    this.sent = 0;
    this.received = 0;
  }
  seal(packet) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, nonce);
    const body = Buffer.from(JSON.stringify({ sequence: this.sent, packet }));
    const sealed = Buffer.concat([nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
    this.sent += 1;
    return sealed.toString('base64');
  }
  open(line) {
    const data = Buffer.from(line, 'base64');
    if (data.length < 28) throw new Error('invalid record');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.receiveKey, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]);
    const record = JSON.parse(plain.toString('utf8'));
    if (record.sequence !== this.received || typeof record.packet !== 'object' || record.packet === null) {
      throw new Error('out of order');
    }
    this.received += 1;
    return record.packet;
  }
}

/// One authenticated connection. `server` is true on the computer, false on the phone.
class LineConnection {
  constructor(socket, secret, server) {
    this.socket = socket;
    this.secret = secret;
    this.server = server;
    this.buffer = Buffer.alloc(0);
    this.channel = null;
    this.challenge = null;
    this.authenticated = false;
    this.closed = false;
    this.onPacket = () => {};
    this.onAuthenticated = () => {};
    this.onClose = () => {};
  }
  start() {
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true, 2000);
    this.socket.on('data', (chunk) => this.receive(chunk));
    this.socket.on('close', () => this.cancel());
    this.socket.on('error', () => this.cancel());
    this.timer = setTimeout(() => { if (!this.authenticated) this.cancel(); }, 8000);
    if (this.server) {
      this.challenge = crypto.randomBytes(32);
      this.handshake({ challenge: this.challenge.toString('base64') });
    }
  }
  send(packet) {
    if (!this.authenticated || !this.channel || this.closed) return;
    try { this.write(this.channel.seal(packet)); } catch { this.cancel(); }
  }
  cancel() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.socket.destroy();
    this.onClose();
  }
  write(text) { this.socket.write(text + '\n'); }
  handshake(fields) { this.write(JSON.stringify(fields)); }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER) { this.cancel(); return; }
    let newline;
    while (!this.closed && (newline = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      this.accept(line);
    }
  }
  accept(line) {
    if (this.channel) {
      let packet;
      try { packet = this.channel.open(line); } catch { this.cancel(); return; }
      if (!this.authenticated) {
        if (this.server || packet.command !== 'paired') { this.cancel(); return; }
        this.authenticated = true;
        clearTimeout(this.timer);
        this.onAuthenticated();
      } else {
        this.onPacket(packet);
      }
      return;
    }
    let json;
    try { json = JSON.parse(line); } catch { this.cancel(); return; }
    if (!json || typeof json !== 'object') { this.cancel(); return; }
    if (this.server) {
      const candidate = typeof json.proof === 'string' ? Buffer.from(json.proof, 'base64') : null;
      if (!candidate || !verifies(candidate, this.secret, this.challenge)) { this.cancel(); return; }
      this.channel = new SecureChannel(this.secret, this.challenge, true);
      this.authenticated = true;
      clearTimeout(this.timer);
      this.send({ command: 'paired' });
      this.onAuthenticated();
    } else {
      const challenge = typeof json.challenge === 'string' ? Buffer.from(json.challenge, 'base64') : null;
      if (!challenge || challenge.length !== 32) { this.cancel(); return; }
      this.channel = new SecureChannel(this.secret, challenge, false);
      this.handshake({ proof: proof(this.secret, challenge).toString('base64') });
    }
  }
}

/// The QR pairing record, identical to the Swift PairingRecord.
const Pairing = {
  create(service) {
    return { version: 1, service, secret: crypto.randomBytes(32).toString('base64') };
  },
  key(record) {
    const key = record && typeof record.secret === 'string' ? Buffer.from(record.secret, 'base64') : null;
    return key && key.length === 32 ? key : null;
  },
  /// Public fingerprint in the Bonjour TXT record ("bluey-id"); the secret still authenticates.
  identifier(record) {
    const key = Pairing.key(record);
    return key ? crypto.createHash('sha256').update(key).digest().subarray(0, 12).toString('hex') : 'invalid';
  },
  qrText(record) {
    return 'bluey-pair:' + Buffer.from(JSON.stringify(record)).toString('base64');
  },
  parse(text) {
    if (typeof text !== 'string' || !text.startsWith('bluey-pair:') || text.length >= 2048) return null;
    try {
      const record = JSON.parse(Buffer.from(text.slice(11), 'base64').toString('utf8'));
      if (record.version !== 1 || !Pairing.key(record) || !record.service) return null;
      return record;
    } catch { return null; }
  },
};

module.exports = { SecureChannel, LineConnection, Pairing, proof, verifies, deriveKey };
