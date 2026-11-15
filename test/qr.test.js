import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encodeQR, renderQR } from '../src/qr.js';

const hash = (m) => crypto.createHash('sha256').update(m.map((r) => r.map((v) => (v ? 1 : 0)).join('')).join('\n')).digest('hex');

// Hashes of matrices that were verified to decode with OpenCV's QR detector.
test('QR matrices match decoder-verified references', () => {
  const a = encodeQR('http://192.168.1.20:4317/?t=k3x9pqmw', 'L');
  assert.equal(a.length, 29);
  assert.equal(hash(a), '791676a528b384b5bb3429716dd4fa60e09c6d1088618325048bfa96fbc7c524');
  const b = encodeQR('x'.repeat(300), 'L'); // version 11: exercises version info and multiple blocks
  assert.equal(b.length, 61);
  assert.equal(hash(b), 'd7800c87eac801b0f650884b741ba20abbe4fe844537a6fd7d779c0feb55fffb');
});

test('finder patterns sit in three corners', () => {
  const m = encodeQR('hello', 'M');
  const n = m.length;
  for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    assert.equal(m[y][x], true);
    assert.equal(m[y + 1][x + 1], false);
    assert.equal(m[y + 3][x + 3], true);
  }
});

test('terminal rendering packs two rows per line', () => {
  const out = renderQR('hello', { color: false, margin: 2 });
  const lines = out.split('\n');
  assert.equal(lines.length, Math.ceil((21 + 4) / 2));
  assert.equal(lines[0].length, 21 + 4);
});

test('capacity boundaries pick the next version, and limits are enforced', () => {
  // Version 1-L holds 17 bytes, version 2-L 32 bytes.
  assert.equal(encodeQR('a'.repeat(17), 'L').length, 21);
  assert.equal(encodeQR('a'.repeat(18), 'L').length, 25);
  assert.equal(encodeQR('a'.repeat(32), 'L').length, 25);
  assert.equal(encodeQR('a'.repeat(33), 'L').length, 29);
  assert.equal(encodeQR('a'.repeat(2953), 'L').length, 177); // version 40
  assert.throws(() => encodeQR('a'.repeat(2954), 'L'), /too long/);
  assert.throws(() => encodeQR('a', 'Q'), /Unsupported/);
});

test('non-ASCII text is encoded as UTF-8 bytes', () => {
  // 'æøå' is 6 bytes in UTF-8; 3 copies (18 bytes) no longer fit version 1-L.
  assert.equal(encodeQR('æøå'.repeat(2), 'L').length, 21);
  assert.equal(encodeQR('æøå'.repeat(3), 'L').length, 25);
});
