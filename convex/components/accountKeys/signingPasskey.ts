/**
 * The npm account's signing passkey: P-256, generated here and never leaving the server. A connector's OpenSK
 * forwards a ceremony's challenge here. Web Crypto's ECDSA, which Convex's default runtime has. Signatures are
 * raw `r‖s`, which is what a WebAuthn assertion carries; this does not build authenticatorData or clientDataJSON.
 */

import { toBase64Url } from "../../model/tokens";

export interface GeneratedSigningPasskey {
  /** 16 random bytes, base64url. The credential id a site stores. */
  readonly credentialId: string;
  /** SPKI, base64. */
  readonly publicKeySpki: string;
  /** PKCS#8, base64: what gets sealed. */
  readonly privateKeyPkcs8: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

export async function generateSigningPasskey(): Promise<GeneratedSigningPasskey> {
  const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  if (!("privateKey" in generated)) throw new Error("P-256 key generation did not return a key pair");
  const publicKeySpki = new Uint8Array(await crypto.subtle.exportKey("spki", generated.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  return {
    credentialId: toBase64Url(credentialId),
    publicKeySpki: toBase64(publicKeySpki),
    privateKeyPkcs8: toBase64(privateKeyPkcs8),
  };
}

/** Signs `challenge` and returns the raw ECDSA P-256 SHA-256 signature, `r‖s`. */
export async function signWithPasskey(privateKeyPkcs8: string, challenge: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(privateKeyPkcs8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, challenge));
}
