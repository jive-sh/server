/**
 * An account's SSH key: ed25519, generated on the server and never leaving it. The private key is kept as PKCS#8,
 * sealed; the public key is handed out in OpenSSH's `authorized_keys` form, which GitHub accepts as both an
 * authentication key and a signing key. Web Crypto's Ed25519, which Convex's default runtime has.
 */

const ALGORITHM = "ssh-ed25519";

/** SSH's wire `string`: a uint32 big-endian length, then the bytes (RFC 4251 §5). */
function sshString(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** `ssh-ed25519 <base64 key blob> <comment>`, the key blob being `string "ssh-ed25519" || string <32 bytes>`. */
function openSshPublicKey(rawPublicKey: Uint8Array, comment: string): string {
  const blob = concat(sshString(new TextEncoder().encode(ALGORITHM)), sshString(rawPublicKey));
  return `${ALGORITHM} ${toBase64(blob)} ${comment}`;
}

export interface GeneratedSshKey {
  /** The OpenSSH public key line. */
  readonly publicKey: string;
  /** The private key as PKCS#8, base64: what gets sealed. */
  readonly privateKeyPkcs8: string;
}

export async function generateSshKey(comment: string): Promise<GeneratedSshKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKey: openSshPublicKey(rawPublicKey, comment), privateKeyPkcs8: toBase64(pkcs8) };
}

/**
 * Signs `data` and returns the signature as SSH encodes it (`string "ssh-ed25519" || string <64 bytes>`, RFC 8709),
 * which is exactly what an SSH agent returns in `SSH_AGENT_SIGN_RESPONSE`. So a local agent forwards each sign
 * request's data unchanged, whatever it is: the SSHSIG blob `ssh-keygen -Y sign` builds for a git commit, or the
 * session-bound blob of an SSH authentication.
 */
export async function signWithSshKey(privateKeyPkcs8: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("pkcs8", fromBase64(privateKeyPkcs8), { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, data));
  return concat(sshString(new TextEncoder().encode(ALGORITHM)), sshString(signature));
}
