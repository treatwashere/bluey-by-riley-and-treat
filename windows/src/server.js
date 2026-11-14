'use strict';
// Advertises this PC as `_googly._tcp` (same as the Mac app) with the pairing fingerprint in the TXT record,
// accepts only phones that prove they hold the QR secret, and streams face/focus packets to them.
const net = require('net');
const { Bonjour } = require('bonjour-service');
const { LineConnection, Pairing } = require('./link');

class PhoneServer {
  constructor(record, name) {
    this.record = record;
    this.name = name;
    this.phones = new Map(); // LineConnection -> name
    this.onPhonesChanged = () => {};
    this.onRequest = () => {};
    this.onAuthenticated = () => {};
    this.lastFace = null;
    this.lastFaceAt = 0;
  }
  get phoneNames() { return [...this.phones.values()].map((n) => n || 'Phone'); }

  start() {
    this.tcp = net.createServer((socket) => this.accept(socket));
    this.tcp.on('error', () => setTimeout(() => this.restart(), 2000));
    this.tcp.listen(0, () => {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: this.name, type: 'googly', protocol: 'tcp', port: this.tcp.address().port,
        txt: { 'bluey-id': Pairing.identifier(this.record) },
      });
    });
  }
  stop() {
    for (const link of this.phones.keys()) link.cancel();
    try { this.bonjour?.unpublishAll(); this.bonjour?.destroy(); } catch {}
    try { this.tcp?.close(); } catch {}
  }
  restart(record) {
    if (record) this.record = record;
    this.stop();
    this.phones.clear();
    this.onPhonesChanged(this.phoneNames);
    this.start();
  }

  accept(socket) {
    const link = new LineConnection(socket, Pairing.key(this.record), true);
    link.onAuthenticated = () => {
      this.phones.set(link, null);
      link.send({ hello: this.name });
      if (this.lastFace) link.send({ face: this.lastFace });
      this.onAuthenticated((packet) => link.send(packet));
      this.onPhonesChanged(this.phoneNames);
    };
    link.onClose = () => {
      if (this.phones.delete(link)) this.onPhonesChanged(this.phoneNames);
    };
    link.onPacket = (packet) => {
      if (!this.phones.has(link)) return;
      if (typeof packet.hello === 'string') { this.phones.set(link, packet.hello.slice(0, 80)); this.onPhonesChanged(this.phoneNames); }
      if (typeof packet.command === 'string') this.onRequest(packet, (reply) => link.send(reply));
    };
    link.start();
  }

  broadcast(packet) { for (const link of this.phones.keys()) link.send(packet); }

  /// Sends the face to every phone, skipping changes too small to see, but at least once a second.
  sendFace(face) {
    const now = Date.now(); const last = this.lastFace;
    if (last && now - this.lastFaceAt < 1000 && last.mood === face.mood && Math.abs(last.gazeX - face.gazeX) < 0.004
      && Math.abs(last.gazeY - face.gazeY) < 0.004 && Math.abs(last.talk - face.talk) < 0.02) return;
    this.lastFace = face; this.lastFaceAt = now;
    this.broadcast({ face });
  }
}

module.exports = { PhoneServer };
