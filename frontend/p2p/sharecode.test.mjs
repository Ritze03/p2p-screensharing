import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_ID, SHARE_CODE_ERROR, generateShareCode, buildShareCode, parseShareCode, isShareCode, deriveRoom, deriveRoomId, derivePassword,
} from './sharecode.js';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

test('generate -> parse round-trips and has the documented shape', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateShareCode();
    assert.match(code, /^[0-9a-hjkmnp-tv-z]{6}(-[0-9a-hjkmnp-tv-z]{4}){8}$/);
    const p = parseShareCode(code);
    assert.equal(p.code, code);
    assert.equal(p.roomPart.length, 6);
    assert.equal(p.secret.length, 28); // 28 * 5 = 140 bits >= 128
    assert.equal(p.roomPart + p.secret, code.replace(/-/g, '').slice(0, 34));
  }
});

test('codes are random (no repeats, secret varies)', () => {
  const codes = new Set(Array.from({ length: 200 }, generateShareCode));
  assert.equal(codes.size, 200);
});

test('derivation is deterministic; roomId and password have expected form', async () => {
  const code = generateShareCode();
  const a = await deriveRoom(code);
  const b = await deriveRoom(parseShareCode(code));
  assert.deepEqual(a, b);
  assert.match(a.roomId, /^[0-9a-hjkmnp-tv-z]{8}$/);
  assert.match(a.password, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.roomId, a.roomPart);
  assert.ok(APP_ID.length > 0);
});

test('different codes -> different rooms and passwords', async () => {
  const a = await deriveRoom(generateShareCode());
  const b = await deriveRoom(generateShareCode());
  assert.notEqual(a.roomId, b.roomId);
  assert.notEqual(a.password, b.password);
});

test('same room part + different secret -> same roomId, different password', async () => {
  const a = parseShareCode(generateShareCode());
  const b = parseShareCode(generateShareCode());
  assert.equal(await deriveRoomId(a.roomPart), await deriveRoomId(a.roomPart));
  assert.notEqual(await derivePassword(a.secret), await derivePassword(b.secret));
  const other = await deriveRoom(buildShareCode(a.roomPart, b.secret));
  const orig = await deriveRoom(a);
  assert.equal(other.roomId, orig.roomId);
  assert.notEqual(other.password, orig.password);
});

test('whitespace, case, dashes and lookalikes are tolerated', () => {
  const code = generateShareCode();
  const p = parseShareCode(code);
  assert.equal(parseShareCode(`  ${code.toUpperCase()}\n`).code, code);
  assert.equal(parseShareCode(code.replace(/-/g, ' ')).code, code);
  assert.equal(parseShareCode(code.replace(/-/g, '')).code, code);
  assert.equal(parseShareCode(code.replace(/-/g, '\t- ')).code, code);
  assert.equal(parseShareCode(`https://example.org/join#${code}`).code, code);
  assert.equal(p.code, code);
});

test('every single-character substitution is rejected', () => {
  for (let n = 0; n < 5; n++) {
    const code = generateShareCode();
    const chars = code.replace(/-/g, '');
    for (let i = 0; i < chars.length; i++) {
      for (const c of ALPHABET) {
        if (c === chars[i]) continue;
        const mangled = chars.slice(0, i) + c + chars.slice(i + 1);
        assert.equal(isShareCode(mangled), false, `pos ${i} -> ${c} accepted`);
      }
    }
  }
});

test('adjacent transpositions of different characters are rejected', () => {
  const code = generateShareCode();
  const chars = code.replace(/-/g, '');
  for (let i = 0; i + 1 < chars.length; i++) {
    if (chars[i] === chars[i + 1]) continue;
    const m = chars.slice(0, i) + chars[i + 1] + chars[i] + chars.slice(i + 2);
    assert.equal(isShareCode(m), false, `swap at ${i} accepted`);
  }
});

test('truncated / extended / garbage / empty input is rejected with the clear message', () => {
  const code = generateShareCode();
  const bad = [
    code.slice(0, -1), code.slice(0, -5), code.slice(0, 6), code + 'a', code + '-abcd',
    '', '   ', 'hello world', 'uuuuuu-uuuu', code.replace(/[^-]/, '!'), '💥', null, undefined, 42, {},
  ];
  for (const b of bad) {
    assert.throws(() => parseShareCode(b), { message: SHARE_CODE_ERROR }, JSON.stringify(b));
  }
  assert.equal(SHARE_CODE_ERROR, 'That share code looks incomplete or mistyped.');
});

test('typing lookalikes (o/i/l) is forgiven by parse', () => {
  const code = buildShareCode('001a1b', '0123456789abcdefghjkmnpqrstv'.slice(0, 28));
  const typed = code.replace(/0/g, 'o').replace(/1/g, 'l').toUpperCase();
  assert.equal(parseShareCode(typed).code, code);
});
