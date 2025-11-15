import { gcm } from '@noble/ciphers/aes.js';
import { concatBytes, equalBytes } from '@noble/ciphers/utils.js';
import { p256 } from '@noble/curves/nist.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { fromByteArray, toByteArray } from 'base64-js';
import { getRandomBytes } from 'expo-crypto';
import { DEFAULT_TTL_SECONDS } from './constants';

export interface TeslaPrivateKey {
  type: 'TESLA_P256';
  d: Uint8Array;
  publicKey?: Uint8Array;
}

export interface TeslaKeyPair {
  privateKey: TeslaPrivateKey;
  publicKey: Uint8Array;
}

export interface TeslaSessionKeys {
  sharedSecret: Uint8Array;
  aesKeyBytes: Uint8Array;
  sessionInfoKey: Uint8Array;
}

const textEncoder = new TextEncoder();

export async function generatePrivateKey(): Promise<TeslaKeyPair> {
  let secret: Uint8Array;
  // Use Expo's CSPRNG and validate with noble's helpers to avoid relying on
  // global crypto.getRandomValues, which is not available in React Native.
  do {
    secret = getRandomBytes(32);
  } while (!p256.utils.isValidSecretKey(secret));
  const publicKey = p256.getPublicKey(secret, false);
  return {
    privateKey: createPrivateKey(secret, publicKey),
    publicKey,
  };
}

export async function importPrivateKeyPem(pem: string): Promise<TeslaPrivateKey> {
  const { label, data } = decodePem(pem);
  if (label === 'EC PRIVATE KEY') {
    return decodeSec1PrivateKey(data);
  }
  if (label === 'PRIVATE KEY') {
    return decodeSec1PrivateKey(pkcs8ToEcPrivateKey(data));
  }
  throw new Error(`Unsupported PEM block: ${label}`);
}

export const importPrivateKeyPkcs8 = importPrivateKeyPem;

export async function importPrivateKeyRaw(raw: ArrayBuffer): Promise<TeslaPrivateKey> {
  const bytes = new Uint8Array(raw);
  try {
    return decodeSec1PrivateKey(pkcs8ToEcPrivateKey(bytes));
  } catch (error) {
    console.warn('Failed to parse PKCS#8 private key, attempting SEC1 fallback.', error);
    return decodeSec1PrivateKey(bytes);
  }
}

export async function exportPrivateKeyPem(privateKey: TeslaPrivateKey): Promise<string> {
  const sec1 = encodeSec1PrivateKey(privateKey);
  return bytesToPem('EC PRIVATE KEY', sec1);
}

export const exportPrivateKeyPkcs8 = exportPrivateKeyPem;

export function exportPublicKeyFromPrivate(privateKey: TeslaPrivateKey): Promise<Uint8Array> {
  return Promise.resolve(derivePublicKey(privateKey));
}

export async function exportPublicKeyPem(publicKey: Uint8Array): Promise<string> {
  const spki = encodePublicKeyToSpki(publicKey);
  return bytesToPem('PUBLIC KEY', spki);
}

export async function exportPublicKeyPemFromPrivate(privateKey: TeslaPrivateKey): Promise<string> {
  const raw = derivePublicKey(privateKey);
  return exportPublicKeyPem(raw);
}

export async function exportPublicKeyRaw(privateKey: TeslaPrivateKey): Promise<Uint8Array> {
  return derivePublicKey(privateKey);
}

export async function publicKeyRawToPem(raw: Uint8Array): Promise<string> {
  return exportPublicKeyPem(raw);
}

export async function publicKeyPemToRaw(pem: string): Promise<Uint8Array> {
  const { label, data } = decodePem(pem);
  if (label !== 'PUBLIC KEY') {
    throw new Error(`Unsupported public key PEM block: ${label}`);
  }
  return decodeSpkiPublicKey(data);
}

export async function deriveSessionKeys(opts: {
  privateKey: TeslaPrivateKey;
  peerPublicKey: Uint8Array;
}): Promise<TeslaSessionKeys> {
  const sharedPoint = p256.getSharedSecret(opts.privateKey.d, opts.peerPublicKey, false);
  const sharedSecret = sharedPoint.slice(1); // strip format byte
  const sha1Digest = sha1(sharedSecret);
  const aesKeyBytes = sha1Digest.slice(0, 16);
  const sessionInfoKey = await hmacSha256(aesKeyBytes, utf8ToBytes('session info'));
  return {
    sharedSecret,
    aesKeyBytes,
    sessionInfoKey,
  };
}

export async function encryptAesGcm(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const cipher = gcm(key, iv, additionalData);
  return cipher.encrypt(plaintext);
}

export async function decryptAesGcm(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const cipher = gcm(key, iv, additionalData);
  return cipher.decrypt(ciphertext);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return nobleSha256(data);
}

export async function hmacSha256(keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  return hmac(nobleSha256, keyBytes, message);
}

export async function verifyHmacSha256(
  keyBytes: Uint8Array,
  message: Uint8Array,
  expected: Uint8Array,
): Promise<boolean> {
  const actual = await hmacSha256(keyBytes, message);
  return timingSafeEqual(actual, expected);
}

export function randomBytes(length: number): Uint8Array {
  return getRandomBytes(length);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export interface CommandMetadata {
  vin: string;
  epoch: Uint8Array;
  counter: number;
  expiresAt?: number;
}

export function encodeMetadata(metadata: CommandMetadata): Uint8Array {
  const chunks: Uint8Array[] = [];
  const counterBytes = new Uint8Array(4);
  const view = new DataView(counterBytes.buffer);
  view.setUint32(0, metadata.counter, true);
  chunks.push(counterBytes);
  chunks.push(metadata.epoch);
  chunks.push(textEncoder.encode(metadata.vin));
  return concat(...chunks);
}

export function defaultExpiry(clockSeconds: number): number {
  return clockSeconds + DEFAULT_TTL_SECONDS;
}

export function concat(...arrays: Uint8Array[]): Uint8Array {
  if (!arrays.length) {
    return new Uint8Array(0);
  }
  const length = arrays.reduce((total, arr) => total + arr.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function createPrivateKey(secret: Uint8Array, publicKey?: Uint8Array): TeslaPrivateKey {
  return {
    type: 'TESLA_P256',
    d: normalizePrivateKeyBytes(secret),
    publicKey: publicKey ? publicKey.slice() : undefined,
  };
}

function normalizePrivateKeyBytes(secret: Uint8Array): Uint8Array {
  if (secret.length === 32) {
    return secret.slice();
  }
  if (secret.length > 32) {
    return secret.slice(secret.length - 32);
  }
  const padded = new Uint8Array(32);
  padded.set(secret, 32 - secret.length);
  return padded;
}

function derivePublicKey(privateKey: TeslaPrivateKey): Uint8Array {
  if (!privateKey.publicKey) {
    privateKey.publicKey = p256.getPublicKey(privateKey.d, false);
  }
  return privateKey.publicKey.slice();
}

function decodeSec1PrivateKey(sec1: Uint8Array): TeslaPrivateKey {
  const root = decodeAsn1Element(sec1, 0);
  if (root.tag !== 0x30) {
    throw new Error('Invalid EC private key structure');
  }
  let offset = root.contentStart;
  const version = decodeAsn1Element(sec1, offset);
  if (version.tag !== 0x02) {
    throw new Error('Invalid EC private key');
  }
  offset = version.contentEnd;
  const keyOctet = decodeAsn1Element(sec1, offset);
  if (keyOctet.tag !== 0x04) {
    throw new Error('Invalid EC private key payload');
  }
  const privateKeyBytes = sec1.slice(keyOctet.contentStart, keyOctet.contentEnd);
  offset = keyOctet.contentEnd;
  let publicKey: Uint8Array | undefined;
  while (offset < root.contentEnd) {
    const element = decodeAsn1Element(sec1, offset);
    if (element.tag === 0xa1) {
      const bitString = decodeAsn1Element(sec1, element.contentStart);
      if (bitString.tag !== 0x03) {
        throw new Error('Invalid EC public key encoding');
      }
      const unusedBits = sec1[bitString.contentStart];
      if (unusedBits !== 0) {
        throw new Error('Unsupported EC public key bit string');
      }
      publicKey = sec1.slice(bitString.contentStart + 1, bitString.contentEnd);
    }
    offset = element.contentEnd;
  }
  return createPrivateKey(privateKeyBytes, publicKey);
}

function encodeSec1PrivateKey(privateKey: TeslaPrivateKey): Uint8Array {
  const version = encodeAsn1(0x02, new Uint8Array([0x01]));
  const keyOctet = encodeAsn1(0x04, privateKey.d);
  const params = encodeAsn1(0xa0, encodeAsn1(0x06, OID_PRIME256V1));
  const pub = encodeAsn1(
    0xa1,
    encodeAsn1(
      0x03,
      concatBytes(new Uint8Array([0x00]), derivePublicKey(privateKey)),
    ),
  );
  return encodeAsn1(0x30, concat(version, keyOctet, params, pub));
}

function encodePublicKeyToSpki(publicKey: Uint8Array): Uint8Array {
  const algorithm = encodeAsn1(
    0x30,
    concat(
      encodeAsn1(0x06, OID_EC_PUBLIC_KEY),
      encodeAsn1(0x06, OID_PRIME256V1),
    ),
  );
  const subjectPublicKey = encodeAsn1(
    0x03,
    concatBytes(new Uint8Array([0x00]), publicKey),
  );
  return encodeAsn1(0x30, concat(algorithm, subjectPublicKey));
}

function decodeSpkiPublicKey(spki: Uint8Array): Uint8Array {
  const root = decodeAsn1Element(spki, 0);
  if (root.tag !== 0x30) {
    throw new Error('Invalid SPKI structure');
  }
  const algorithm = decodeAsn1Element(spki, root.contentStart);
  if (algorithm.tag !== 0x30) {
    throw new Error('Invalid SPKI algorithm section');
  }
  const pub = decodeAsn1Element(spki, algorithm.contentEnd);
  if (pub.tag !== 0x03) {
    throw new Error('Invalid SPKI public key bit string');
  }
  const unusedBits = spki[pub.contentStart];
  if (unusedBits !== 0) {
    throw new Error('Unsupported SPKI public key encoding');
  }
  return spki.slice(pub.contentStart + 1, pub.contentEnd);
}

function decodePem(pem: string): { label: string; data: Uint8Array } {
  const match = pem.match(/-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/);
  if (!match) {
    throw new Error('Invalid PEM format');
  }
  const label = match[1].trim();
  const body = match[2].replace(/[^A-Za-z0-9+/=]/g, '');
  const data = toByteArray(body);
  return { label, data };
}

function bytesToPem(label: string, data: Uint8Array): string {
  const encoded = fromByteArray(data);
  const formatted = encoded.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${formatted}\n-----END ${label}-----`;
}

function pkcs8ToEcPrivateKey(pkcs8: Uint8Array): Uint8Array {
  const root = decodeAsn1Element(pkcs8, 0);
  if (root.tag !== 0x30) {
    throw new Error('Invalid PKCS#8 structure');
  }
  let offset = root.contentStart;
  const version = decodeAsn1Element(pkcs8, offset);
  if (version.tag !== 0x02) {
    throw new Error('Invalid PKCS#8 version');
  }
  offset = version.contentEnd;
  const algorithm = decodeAsn1Element(pkcs8, offset);
  if (algorithm.tag !== 0x30) {
    throw new Error('Invalid PKCS#8 algorithm identifier');
  }
  offset = algorithm.contentEnd;
  const privateKey = decodeAsn1Element(pkcs8, offset);
  if (privateKey.tag !== 0x04) {
    throw new Error('Invalid PKCS#8 private key');
  }
  return pkcs8.slice(privateKey.contentStart, privateKey.contentEnd);
}

function encodeAsn1(tag: number, content: Uint8Array): Uint8Array {
  const length = encodeAsn1Length(content.length);
  const result = new Uint8Array(1 + length.length + content.length);
  result[0] = tag;
  result.set(length, 1);
  result.set(content, 1 + length.length);
  return result;
}

function encodeAsn1Length(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function decodeAsn1Element(bytes: Uint8Array, offset: number): {
  tag: number;
  length: number;
  headerLength: number;
  contentStart: number;
  contentEnd: number;
  totalLength: number;
} {
  if (offset >= bytes.length) {
    throw new Error('ASN.1 parse error: offset out of range');
  }
  const tag = bytes[offset];
  const { length, lengthBytes } = decodeAsn1Length(bytes, offset + 1);
  const headerLength = 1 + lengthBytes;
  const contentStart = offset + headerLength;
  const contentEnd = contentStart + length;
  if (contentEnd > bytes.length) {
    throw new Error('ASN.1 parse error: length out of range');
  }
  return {
    tag,
    length,
    headerLength,
    contentStart,
    contentEnd,
    totalLength: headerLength + length,
  };
}

function decodeAsn1Length(bytes: Uint8Array, offset: number): { length: number; lengthBytes: number } {
  if (offset >= bytes.length) {
    throw new Error('ASN.1 parse error: missing length');
  }
  const first = bytes[offset];
  if ((first & 0x80) === 0) {
    return { length: first, lengthBytes: 1 };
  }
  const count = first & 0x7f;
  if (count === 0) {
    throw new Error('ASN.1 parse error: indefinite length not supported');
  }
  if (offset + 1 + count > bytes.length) {
    throw new Error('ASN.1 parse error: truncated length');
  }
  let length = 0;
  for (let i = 0; i < count; i += 1) {
    length = (length << 8) | bytes[offset + 1 + i];
  }
  return { length, lengthBytes: 1 + count };
}

const OID_EC_PUBLIC_KEY = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const OID_PRIME256V1 = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
