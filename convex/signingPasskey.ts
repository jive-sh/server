import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action } from "./_generated/server";

/**
 * Signing with the organization's npm passkey. OpenSK sends the ceremony's challenge with the person's session
 * token and the code repository, and gets back the signature. The passkey is held by the accountKeys component,
 * one per organization, beside that organization's npm connection. Every call resolves the session first.
 */

const NOT_SIGNED_IN = "The session token opens no live session. Sign in again.";

const repositoryArgs = {
  sessionToken: v.string(),
  repositoryOwner: v.string(),
  repositoryName: v.string(),
};

const fromBase64 = (value: string): ArrayBuffer =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).buffer;

const toBase64 = (bytes: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** The organization's signing passkey, creating it on the first call. Idempotent: one key per organization. */
export const ensure = action({
  args: repositoryArgs,
  returns: v.object({ credentialId: v.string(), publicKeySpki: v.string() }),
  handler: async (ctx, repository) => {
    const organizationId = await ctx.runQuery(internal.npmSessions.organizationForRepository, repository);
    if (organizationId === null) throw new ConvexError(NOT_SIGNED_IN);
    return await ctx.runAction(components.accountKeys.npmConnection.ensurePasskey, { organizationId });
  },
});

/**
 * Signs `challenge` (base64) with the organization's passkey. Returns the raw ECDSA signature, base64. The server
 * does not interpret the challenge.
 */
export const sign = action({
  args: { ...repositoryArgs, challenge: v.string() },
  returns: v.object({ signature: v.string() }),
  handler: async (ctx, { challenge, ...repository }) => {
    const organizationId = await ctx.runQuery(internal.npmSessions.organizationForRepository, repository);
    if (organizationId === null) throw new ConvexError(NOT_SIGNED_IN);
    const signed = await ctx.runAction(components.accountKeys.npmConnection.sign, {
      organizationId,
      challenge: fromBase64(challenge),
    });
    return { signature: toBase64(signed.signature) };
  },
});
