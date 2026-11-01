/**
 * Bearer secrets Jive hands out (session tokens, sign-in request claim secrets, WebAuthn challenges): 32 random
 * bytes, base64url, behind a prefix that makes one found in a log or file recognisable. Only their SHA-256 is
 * ever stored. Minting needs real randomness, so it runs in actions only; queries and mutations are
 * deterministic.
 */

export const SESSION_TOKEN_PREFIX = "jive_";
export const CLAIM_SECRET_PREFIX = "jive_claim_";

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
}

export function mintSecret(prefix: string): string {
  return `${prefix}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
