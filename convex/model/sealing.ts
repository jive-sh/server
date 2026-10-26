import { Data, Effect } from "effect";

/**
 * Credentials at rest, sealed the way @jive-sh/app seals connection payloads (its `src/modules/crypto/impl.ts`,
 * `docs/db-model.md`): AES-256-GCM with a fresh 12-byte nonce per message, stored as `<nonce>.<ciphertext>`
 * base64url beside the version of the key that sealed it, so the key can rotate. Web Crypto only, which Convex's
 * default runtime has.
 */

/** `CONNECTION_KEY` is missing or malformed. Never carries the key. */
export class ConnectionKeyUnusable extends Data.TaggedError("ConnectionKeyUnusable")<{ readonly reason: string }> {
  override get message(): string {
    return `CONNECTION_KEY is unusable: ${this.reason}`;
  }
}

/** A sealed value could not be opened: tampered with, or sealed under another key. Deliberately no more specific. */
export class SealedValueUnreadable extends Data.TaggedError("SealedValueUnreadable")<{}> {
  override get message(): string {
    return "a sealed credential could not be opened with CONNECTION_KEY";
  }
}

export interface ConnectionKey {
  readonly version: number;
  readonly key: Uint8Array<ArrayBuffer>;
}

const NONCE_BYTES = 12;

/** Parses `<version>:<base64 32-byte key>`, the form jive-abstract-backend-convex generates (`prefix: "1:"`). */
export function parseConnectionKey(maybeValue: string | undefined): Effect.Effect<ConnectionKey, ConnectionKeyUnusable> {
  return Effect.suspend(() => {
    const value = maybeValue ?? "";
    const separator = value.indexOf(":");
    if (separator <= 0) return Effect.fail(new ConnectionKeyUnusable({ reason: "expected <version>:<base64 key>" }));
    const version = Number(value.slice(0, separator));
    let key: Uint8Array<ArrayBuffer>;
    try {
      key = Uint8Array.from(atob(value.slice(separator + 1)), (character) => character.charCodeAt(0));
    } catch {
      return Effect.fail(new ConnectionKeyUnusable({ reason: "the key is not base64" }));
    }
    if (!Number.isInteger(version) || version < 1 || key.byteLength !== 32) {
      return Effect.fail(new ConnectionKeyUnusable({ reason: "expected a version from 1 and a 32-byte key" }));
    }
    return Effect.succeed({ version, key });
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
}

function importKey(key: Uint8Array<ArrayBuffer>, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [usage]);
}

export function seal(key: ConnectionKey, plaintext: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await importKey(key.key, "encrypt"),
      new TextEncoder().encode(plaintext),
    ));
    return `${toBase64Url(nonce)}.${toBase64Url(ciphertext)}`;
  });
}

export function open(key: ConnectionKey, sealed: string): Effect.Effect<string, SealedValueUnreadable> {
  const [nonce, ciphertext, ...rest] = sealed.split(".");
  if (nonce === undefined || ciphertext === undefined || rest.length > 0) return Effect.fail(new SealedValueUnreadable());
  return Effect.tryPromise({
    try: async () => new TextDecoder().decode(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(nonce) },
      await importKey(key.key, "decrypt"),
      fromBase64Url(ciphertext),
    )),
    catch: () => new SealedValueUnreadable(),
  });
}
