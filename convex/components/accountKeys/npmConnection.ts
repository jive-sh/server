import { ConvexError, v } from "convex/values";
import { Effect, pipe } from "effect";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { openWithDeploymentKey, sealWithDeploymentKey } from "../../model/sealing";
import { generateSigningPasskey, signWithPasskey } from "./signingPasskey";

/**
 * The organization's npm connection (connector `npm`) and the signing passkey registered on that npm account.
 *
 * `token` and `sign` are what `provision` calls once it has the organization. It passes the token to the npm
 * connector's `resource.ensureInstance`, and calls `sign` when npm asks for a second factor. They do not check a
 * session: the installing app does that before it calls them, and passes the organization id. `sign` returns the
 * raw ECDSA signature, not a WebAuthn assertion. `save`, `status`, `markRegistered` and `ensurePasskey` are how
 * the app's session-checked wrappers write the connection; they are not that contract.
 */

const NO_PASSKEY = "This organization has no signing passkey yet.";
const CONNECTOR = "npm" as const;

const tokenFailure = (e: { readonly message: string }) => new Error(`the organization's npm connection: ${e.message}`);
const passkeyFailure = (e: { readonly message: string }) => new Error(`the organization's signing passkey: ${e.message}`);

const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

/**
 * The npm token, or null when this organization has no connection. Unseals under `CONNECTION_KEY`.
 */
export const token = action({
  args: { organizationId: v.string() },
  returns: v.union(v.null(), v.object({ token: v.string() })),
  handler: async (ctx, { organizationId }) => {
    const stored = await ctx.runQuery(internal.npmConnection.sealedToken, { organizationId });
    if (stored === null) return null;
    const token = await Effect.runPromise(pipe(
      openWithDeploymentKey({ sealed: stored.sealedToken, keyVersion: stored.keyVersion }),
      Effect.mapError(tokenFailure),
    ));
    return { token };
  },
});

/**
 * Signs `challenge` with the organization's npm passkey. `signature` is raw ECDSA P-256 SHA-256 `r‖s`.
 * Throws when the organization has no passkey yet.
 */
export const sign = action({
  args: { organizationId: v.string(), challenge: v.bytes() },
  returns: v.object({ credentialId: v.string(), signature: v.bytes() }),
  handler: async (ctx, { organizationId, challenge }) => {
    const key = await ctx.runQuery(internal.npmConnection.sealedPasskey, { organizationId });
    if (key === null) throw new ConvexError(NO_PASSKEY);
    const privateKeyPkcs8 = await Effect.runPromise(pipe(
      openWithDeploymentKey({ sealed: key.sealedPrivateKey, keyVersion: key.keyVersion }),
      Effect.mapError(passkeyFailure),
    ));
    const signature = await signWithPasskey(privateKeyPkcs8, new Uint8Array(challenge));
    return { credentialId: key.credentialId, signature: arrayBuffer(signature) };
  },
});

/** Seals and stores the npm token for the organization, replacing one already stored. */
export const save = action({
  args: { organizationId: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { organizationId, token }) => {
    const sealed = await Effect.runPromise(pipe(sealWithDeploymentKey(token), Effect.mapError(tokenFailure)));
    await ctx.runMutation(internal.npmConnection.store, {
      organizationId,
      sealedToken: sealed.sealed,
      keyVersion: sealed.keyVersion,
    });
    return null;
  },
});

/** Whether the organization has an npm token, and whether npm has accepted the signing passkey. */
export const status = query({
  args: { organizationId: v.string() },
  returns: v.object({ hasToken: v.boolean(), passkeyRegistered: v.boolean() }),
  handler: async (ctx, { organizationId }) => {
    const stored = await ctx.db
      .query("npmConnections")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", organizationId).eq("connector", CONNECTOR))
      .unique();
    return { hasToken: stored !== null, passkeyRegistered: stored?.passkeyRegistered ?? false };
  },
});

/** Records that npm accepted the signing passkey, so a later publish does not need the person. */
export const markRegistered = mutation({
  args: { organizationId: v.string() },
  returns: v.null(),
  handler: async (ctx, { organizationId }) => {
    const existing = await ctx.db
      .query("npmConnections")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", organizationId).eq("connector", CONNECTOR))
      .unique();
    if (existing !== null) await ctx.db.patch(existing._id, { passkeyRegistered: true });
    return null;
  },
});

/** The organization's signing passkey, creating it on the first call. Idempotent: one passkey per organization. */
export const ensurePasskey = action({
  args: { organizationId: v.string() },
  returns: v.object({ credentialId: v.string(), publicKeySpki: v.string() }),
  handler: async (ctx, { organizationId }) => {
    const existing = await ctx.runQuery(internal.npmConnection.passkeyPublic, { organizationId });
    if (existing !== null) return existing;
    const generated = await generateSigningPasskey();
    const { sealed, keyVersion } = await Effect.runPromise(pipe(
      sealWithDeploymentKey(generated.privateKeyPkcs8),
      Effect.mapError(passkeyFailure),
    ));
    return await ctx.runMutation(internal.npmConnection.storePasskey, {
      organizationId,
      credentialId: generated.credentialId,
      publicKeySpki: generated.publicKeySpki,
      sealedPrivateKey: sealed,
      keyVersion,
    });
  },
});

export const sealedToken = internalQuery({
  args: { organizationId: v.string() },
  returns: v.union(v.null(), v.object({ sealedToken: v.string(), keyVersion: v.number() })),
  handler: async (ctx, { organizationId }) => {
    const stored = await ctx.db
      .query("npmConnections")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", organizationId).eq("connector", CONNECTOR))
      .unique();
    return stored === null ? null : { sealedToken: stored.sealedToken, keyVersion: stored.keyVersion };
  },
});

export const store = internalMutation({
  args: { organizationId: v.string(), sealedToken: v.string(), keyVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("npmConnections")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", args.organizationId).eq("connector", CONNECTOR))
      .unique();
    if (existing === null) {
      await ctx.db.insert("npmConnections", {
        organizationId: args.organizationId,
        connector: CONNECTOR,
        sealedToken: args.sealedToken,
        keyVersion: args.keyVersion,
        passkeyRegistered: false,
        createdAt: Date.now(),
      });
    } else {
      await ctx.db.patch(existing._id, { sealedToken: args.sealedToken, keyVersion: args.keyVersion });
    }
    return null;
  },
});

export const passkeyPublic = internalQuery({
  args: { organizationId: v.string() },
  returns: v.union(v.null(), v.object({ credentialId: v.string(), publicKeySpki: v.string() })),
  handler: async (ctx, { organizationId }) => {
    const key = await ctx.db
      .query("signingPasskeys")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", organizationId).eq("connector", CONNECTOR))
      .unique();
    return key === null ? null : { credentialId: key.credentialId, publicKeySpki: key.publicKeySpki };
  },
});

export const sealedPasskey = internalQuery({
  args: { organizationId: v.string() },
  returns: v.union(v.null(), v.object({
    credentialId: v.string(),
    sealedPrivateKey: v.string(),
    keyVersion: v.number(),
  })),
  handler: async (ctx, { organizationId }) => {
    const key = await ctx.db
      .query("signingPasskeys")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", organizationId).eq("connector", CONNECTOR))
      .unique();
    return key === null ? null : { credentialId: key.credentialId, sealedPrivateKey: key.sealedPrivateKey, keyVersion: key.keyVersion };
  },
});

/** Stores the passkey unless one was stored meanwhile, and returns the public key the organization ends up with. */
export const storePasskey = internalMutation({
  args: {
    organizationId: v.string(),
    credentialId: v.string(),
    publicKeySpki: v.string(),
    sealedPrivateKey: v.string(),
    keyVersion: v.number(),
  },
  returns: v.object({ credentialId: v.string(), publicKeySpki: v.string() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("signingPasskeys")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", args.organizationId).eq("connector", CONNECTOR))
      .unique();
    if (existing !== null) return { credentialId: existing.credentialId, publicKeySpki: existing.publicKeySpki };
    await ctx.db.insert("signingPasskeys", { ...args, connector: CONNECTOR, createdAt: Date.now() });
    return { credentialId: args.credentialId, publicKeySpki: args.publicKeySpki };
  },
});
