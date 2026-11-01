import { describe, expect, test } from "bun:test";
import { generateSigningPasskey, signWithPasskey } from "../convex/components/accountKeys/signingPasskey";

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

describe("the signing passkey", () => {
  test("a signature over a challenge verifies with the public key that was generated with it", async () => {
    const generated = await generateSigningPasskey();
    const challenge = new TextEncoder().encode("ceremony");
    const signature = await signWithPasskey(generated.privateKeyPkcs8, challenge);
    const publicKey = await crypto.subtle.importKey(
      "spki",
      fromBase64(generated.publicKeySpki),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge)).toBe(true);
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      new TextEncoder().encode("other"),
    )).toBe(false);
  });
});
