/**
 * A passkey in software: a P-256 key pair answering WebAuthn ceremonies with the exact bytes a browser and
 * authenticator produce (attestation "none", user present and verified), so the server's real verification runs.
 * Only what the tests need: one credential, `ES256`, no extensions.
 */

type Cbor = number | string | Uint8Array | ReadonlyMap<Cbor, Cbor> | { readonly [key: string]: Cbor };

/** Minimal canonical-enough CBOR: unsigned and negative ints, byte and text strings, maps. */
function encodeCbor(value: Cbor): Uint8Array {
  const head = (major: number, length: number): Array<number> => {
    if (length < 24) return [(major << 5) | length];
    if (length < 0x100) return [(major << 5) | 24, length];
    if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
    throw new Error("too long for this encoder");
  };
  if (typeof value === "number") return Uint8Array.from(value >= 0 ? head(0, value) : head(1, -1 - value));
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return Uint8Array.from([...head(3, bytes.length), ...bytes]);
  }
  if (value instanceof Uint8Array) return Uint8Array.from([...head(2, value.length), ...value]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Uint8Array.from([...head(5, entries.length), ...entries.flatMap(([key, item]) => [...encodeCbor(key), ...encodeCbor(item)])]);
}

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => Uint8Array.from(parts.flatMap((part) => [...part]));

/** Web Crypto signs ECDSA as raw r||s; WebAuthn carries it DER-encoded. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.slice(start);
    return trimmed[0]! & 0x80 ? Uint8Array.from([0x02, trimmed.length + 1, 0, ...trimmed]) : Uint8Array.from([0x02, trimmed.length, ...trimmed]);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return Uint8Array.from([0x30, body.length, ...body]);
}

export interface SoftwarePasskey {
  readonly credentialId: string;
  /** The COSE public key, base64url: what the server stores for this passkey. */
  readonly publicKey: string;
  /** The browser's `navigator.credentials.create` result, as `@simplewebauthn/browser` serializes it. */
  register(options: { readonly challenge: string; readonly user: { readonly id: string } }, origin?: string): Promise<unknown>;
  /** The browser's `navigator.credentials.get` result for these options. */
  signIn(options: { readonly challenge: string }, origin?: string): Promise<unknown>;
}

export async function createSoftwarePasskey(relyingPartyId: string): Promise<SoftwarePasskey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const coseKey = encodeCbor(new Map<Cbor, Cbor>([
    [1, 2], [3, -7], [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
    [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
  ]));
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const credentialId = base64Url(rawId);
  const rpIdHash = await sha256(new TextEncoder().encode(relyingPartyId));
  // User present (0x01) and user verified (0x04); 0x40 marks attested credential data.
  const userPresentAndVerified = 0x05;
  let userHandle = "";

  const clientData = (type: string, challenge: string, origin: string) =>
    new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    credentialId,
    publicKey: base64Url(coseKey),
    async register(options, origin = `https://${relyingPartyId}`) {
      userHandle = options.user.id;
      const authData = concat(
        rpIdHash,
        Uint8Array.from([userPresentAndVerified | 0x40, 0, 0, 0, 0]),
        new Uint8Array(16),
        Uint8Array.from([0, rawId.length]),
        rawId,
        coseKey,
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: base64Url(clientData("webauthn.create", options.challenge, origin)),
          attestationObject: base64Url(encodeCbor({ fmt: "none", attStmt: new Map(), authData })),
          transports: ["internal"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    async signIn(options, origin = `https://${relyingPartyId}`) {
      const authData = concat(rpIdHash, Uint8Array.from([userPresentAndVerified, 0, 0, 0, 0]));
      const clientDataJSON = clientData("webauthn.get", options.challenge, origin);
      const signed = concat(authData, await sha256(clientDataJSON));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          authenticatorData: base64Url(authData),
          clientDataJSON: base64Url(clientDataJSON),
          signature: base64Url(derSignature(raw)),
          userHandle: userHandle === "" ? undefined : userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}
