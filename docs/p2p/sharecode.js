// sharecode.js - the "one code" that identifies AND unlocks a room (design D8).
//
// Import-free and browser/Node neutral: uses only Web Crypto (globalThis.crypto)
// so `node --test` can exercise it and the future web client can reuse it as is.
//
// Code layout (all lowercase Crockford base32, groups joined by "-"):
//
//   <room:6> - <secret:4> x7 - <check:4>
//   e.g.  k7m2xq-h4d9-f3wn-8tzp-c6vj-r2be-a5yg-m3xd-9fk2
//
//   room   30 random bits. Public: becomes the Trystero roomId (via SHA-256).
//   secret 140 random bits (>= 128). Secret: becomes the Trystero password
//          (via SHA-256). Never used anywhere else.
//   check  20-bit CRC over room+secret. Typo detection only, NOT security. The
//          CRC polynomial has degree 20 and a constant term, so ANY error burst
//          up to 20 bits is caught with certainty - i.e. any single mistyped
//          character (5 bits) and any adjacent transposition (10 bits).
//
// Because roomId = f(room) and password = f(secret) independently, "same room,
// wrong password" is a real, testable situation (two codes sharing the first
// group but differing in the secret).

/** Trystero appId. The web client MUST use the same value to interoperate. */
export const APP_ID = 'p2p-screensharing.v1';

export const SHARE_CODE_ERROR = 'That share code looks incomplete or mistyped.';

// Crockford base32: no i, l, o, u. Index = symbol value.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ALIASES = { o: '0', i: '1', l: '1' }; // forgiving on manual typing
const ROOM_LEN = 6;
const SECRET_LEN = 28;
const CHECK_LEN = 4;
const GROUP = 4;
const CRC_POLY = 0xa9b25; // low 20 bits of a degree-20 polynomial; LSB set => bursts <= 20 bits always detected

function randomSymbols(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so `& 31` is unbiased.
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

function crc20(symbols) {
  let crc = 0;
  for (const ch of symbols) {
    const v = ALPHABET.indexOf(ch);
    for (let b = 4; b >= 0; b--) {
      const top = (crc >> 19) & 1;
      crc = (crc << 1) & 0xfffff;
      if (top ^ ((v >> b) & 1)) crc ^= CRC_POLY;
    }
  }
  return crc;
}

function checkSymbols(payload) {
  const crc = crc20(payload);
  let out = '';
  for (let i = CHECK_LEN - 1; i >= 0; i--) out += ALPHABET[(crc >> (5 * i)) & 31];
  return out;
}

/** Assemble a code from a room part and secret (both base32 symbol strings). */
export function buildShareCode(room, secret) {
  if (room.length !== ROOM_LEN || secret.length !== SECRET_LEN || [...room + secret].some((c) => ALPHABET.indexOf(c) < 0)) {
    throw new Error('buildShareCode: room must be 6 and secret 28 base32 symbols');
  }
  const groups = [room];
  for (let i = 0; i < secret.length; i += GROUP) groups.push(secret.slice(i, i + GROUP));
  groups.push(checkSymbols(room + secret));
  return groups.join('-');
}

/** Fresh random share code (crypto.getRandomValues). */
export function generateShareCode() {
  return buildShareCode(randomSymbols(ROOM_LEN), randomSymbols(SECRET_LEN));
}

/**
 * Parse user input into `{ roomPart, secret, code }` (`code` = canonical form).
 * Case-insensitive; ignores whitespace, dashes and a leading "...#" (so a future
 * join link "https://host/#<code>" also works). Throws Error(SHARE_CODE_ERROR)
 * for anything that is not a complete, checksum-valid code.
 */
export function parseShareCode(input) {
  if (typeof input !== 'string') throw new Error(SHARE_CODE_ERROR);
  let s = input.includes('#') ? input.slice(input.lastIndexOf('#') + 1) : input;
  s = s.toLowerCase().replace(/[\s\-_.]+/g, '');
  let norm = '';
  for (const ch of s) {
    const c = ALIASES[ch] ?? ch;
    if (ALPHABET.indexOf(c) < 0) throw new Error(SHARE_CODE_ERROR);
    norm += c;
  }
  if (norm.length !== ROOM_LEN + SECRET_LEN + CHECK_LEN) throw new Error(SHARE_CODE_ERROR);
  const payload = norm.slice(0, ROOM_LEN + SECRET_LEN);
  if (checkSymbols(payload) !== norm.slice(payload.length)) throw new Error(SHARE_CODE_ERROR);
  const roomPart = payload.slice(0, ROOM_LEN);
  const secret = payload.slice(ROOM_LEN);
  return { roomPart, secret, code: buildShareCode(roomPart, secret) };
}

/** True if `input` parses as a valid share code. */
export function isShareCode(input) {
  try {
    parseShareCode(input);
    return true;
  } catch {
    return false;
  }
}

async function sha256(text) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** roomId = first 40 bits of SHA-256("<APP_ID>/room/<roomPart>") as 8 base32 chars. */
export async function deriveRoomId(roomPart) {
  const h = await sha256(`${APP_ID}/room/${roomPart}`);
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(h[i]);
  let out = '';
  for (let i = 7; i >= 0; i--) out += ALPHABET[Number((bits >> BigInt(5 * i)) & 31n)];
  return out;
}

/** password = base64url(SHA-256("<APP_ID>/password/<secret>")), 43 chars / 256 bits. */
export async function derivePassword(secret) {
  const h = await sha256(`${APP_ID}/password/${secret}`);
  let bin = '';
  for (const b of h) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Code (string or parseShareCode result) -> `{ roomId, password, code, roomPart }`. */
export async function deriveRoom(codeOrParsed) {
  const p = typeof codeOrParsed === 'string' ? parseShareCode(codeOrParsed) : codeOrParsed;
  return { roomId: await deriveRoomId(p.roomPart), password: await derivePassword(p.secret), code: p.code, roomPart: p.roomPart };
}
