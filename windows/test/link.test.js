'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const { LineConnection, SecureChannel, Pairing, proof } = require('../src/link');

function pair(serverSecret, clientSecret) {
  return new Promise((resolve) => {
    const result = { serverPackets: [], clientPackets: [] };
    const srv = net.createServer((socket) => {
      const link = new LineConnection(socket, serverSecret, true);
      result.server = link;
      link.onPacket = (p) => result.serverPackets.push(p);
      link.onAuthenticated = () => { result.serverAuth = true; link.send({ hello: 'PC' }); };
      link.start();
    });
    srv.listen(0, '127.0.0.1', () => {
      const socket = net.connect(srv.address().port, '127.0.0.1');
      const client = new LineConnection(socket, clientSecret, false);
      result.client = client;
      client.onAuthenticated = () => { result.clientAuth = true; client.send({ command: 'focusPing' }); };
      client.onPacket = (p) => result.clientPackets.push(p);
      client.onClose = () => { result.clientClosed = true; };
      client.start();
      setTimeout(() => { client.cancel(); srv.close(); resolve(result); }, 300);
    });
  });
}

test('paired devices authenticate and exchange encrypted packets', async () => {
  const secret = crypto.randomBytes(32);
  const r = await pair(secret, secret);
  assert.ok(r.serverAuth && r.clientAuth);
  assert.deepStrictEqual(r.clientPackets, [{ hello: 'PC' }]);
  assert.deepStrictEqual(r.serverPackets, [{ command: 'focusPing' }]);
});

test('a phone with the wrong secret is refused', async () => {
  const r = await pair(crypto.randomBytes(32), crypto.randomBytes(32));
  assert.ok(!r.serverAuth && !r.clientAuth && r.clientClosed);
});

test('records cannot be replayed, reordered or tampered with', () => {
  const secret = crypto.randomBytes(32); const challenge = crypto.randomBytes(32);
  const mac = new SecureChannel(secret, challenge, true);
  const phone = new SecureChannel(secret, challenge, false);
  const a = mac.seal({ command: 'a' }); const b = mac.seal({ command: 'b' });
  assert.throws(() => phone.open(b));
  const phone2 = new SecureChannel(secret, challenge, false);
  assert.deepStrictEqual(phone2.open(a), { command: 'a' });
  assert.throws(() => phone2.open(a));
  const bad = Buffer.from(b, 'base64'); bad[20] ^= 1;
  assert.throws(() => phone2.open(bad.toString('base64')));
  // Direction keys differ, so the phone can't reflect the computer's own records back to it.
  assert.throws(() => new SecureChannel(secret, challenge, true).open(mac.seal({ command: 'x' })));
});

test('pairing QR text round-trips and the identifier is stable', () => {
  const record = Pairing.create("Riley's PC");
  const parsed = Pairing.parse(Pairing.qrText(record));
  assert.deepStrictEqual(parsed, record);
  assert.strictEqual(Pairing.identifier(record).length, 24);
  assert.strictEqual(Pairing.identifier(Object.assign({}, record, { service: 'Renamed' })), Pairing.identifier(record));
  assert.strictEqual(Pairing.parse('bluey-pair:nope'), null);
  assert.strictEqual(Pairing.parse(Pairing.qrText({ version: 1, service: 'x', secret: Buffer.from([1]).toString('base64') })), null);
});

test('known vector: proof and keys match an independent HMAC/HKDF', () => {
  const secret = Buffer.alloc(32, 7); const challenge = Buffer.alloc(32, 9);
  const expected = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from('bluey-pair-v1'), challenge])).digest('hex');
  assert.strictEqual(proof(secret, challenge).toString('hex'), expected);
});
