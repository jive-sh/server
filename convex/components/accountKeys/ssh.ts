import { ConvexError, v } from "convex/values";
import { Effect, pipe } from "effect";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { openWithDeploymentKey, sealWithDeploymentKey } from "../../model/sealing";
import { generateSshKey, signWithSshKey } from "./sshKeys";

/**
 * The account's SSH key. The installing app checks the session, then calls these with the account id. One key per
 * account. The private key is sealed under the component's `CONNECTION_KEY`, which the app forwards.
 */

const NO_KEY = "This account has no SSH key yet. Create one first.";

const sealedFailure = (e: { readonly message: string }) => new Error(`the account's SSH key: ${e.message}`);

const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

/** The account's public key, creating the key on the first call. Idempotent: one key per account. */
export const createKey = action({
  args: { accountId: v.string(), username: v.string() },
  returns: v.object({ publicKey: v.string() }),
  handler: async (ctx, { accountId, username }) => {
    const existing = await ctx.runQuery(internal.ssh.publicKeyForAccount, { accountId });
    if (existing !== null) return { publicKey: existing };
    const generated = await generateSshKey(`${username}@jive.sh`);
    const { sealed, keyVersion } = await Effect.runPromise(pipe(sealWithDeploymentKey(generated.privateKeyPkcs8), Effect.mapError(sealedFailure)));
    const publicKey = await ctx.runMutation(internal.ssh.storeKey, {
      accountId,
      publicKey: generated.publicKey,
      sealedPrivateKey: sealed,
      keyVersion,
    });
    return { publicKey };
  },
});

/** The account's OpenSSH public key, or null before `createKey`. */
export const publicKey = query({
  args: { accountId: v.string() },
  returns: v.union(v.null(), v.object({ publicKey: v.string() })),
  handler: async (ctx, { accountId }) => {
    const key = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    return key === null ? null : { publicKey: key.publicKey };
  },
});

/**
 * Signs `data` with the account's SSH key. The signature is SSH's encoding (`string "ssh-ed25519" || string
 * <64-byte signature>`). This does not read `data`.
 */
export const sign = action({
  args: { accountId: v.string(), data: v.bytes() },
  returns: v.object({ signature: v.bytes() }),
  handler: async (ctx, { accountId, data }) => {
    const key = await ctx.runQuery(internal.ssh.sealedForAccount, { accountId });
    if (key === null) throw new ConvexError(NO_KEY);
    const privateKeyPkcs8 = await Effect.runPromise(pipe(
      openWithDeploymentKey({ sealed: key.sealedPrivateKey, keyVersion: key.keyVersion }),
      Effect.mapError(sealedFailure),
    ));
    const signature = await signWithSshKey(privateKeyPkcs8, new Uint8Array(data));
    return { signature: arrayBuffer(signature) };
  },
});

/** The sealed private key, or null when the account has none. The ciphertext, never the opened key. */
export const sealed = query({
  args: { accountId: v.string() },
  returns: v.union(v.null(), v.object({ sealedPrivateKey: v.string(), keyVersion: v.number() })),
  handler: async (ctx, { accountId }) => {
    const key = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    return key === null ? null : { sealedPrivateKey: key.sealedPrivateKey, keyVersion: key.keyVersion };
  },
});

export const publicKeyForAccount = internalQuery({
  args: { accountId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { accountId }) => {
    const key = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    return key === null ? null : key.publicKey;
  },
});

/** Stores the key unless one was stored meanwhile, and returns the public key the account ends up with. */
export const storeKey = internalMutation({
  args: { accountId: v.string(), publicKey: v.string(), sealedPrivateKey: v.string(), keyVersion: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (existing !== null) return existing.publicKey;
    await ctx.db.insert("sshKeys", { ...args, createdAt: Date.now() });
    return args.publicKey;
  },
});

export const sealedForAccount = internalQuery({
  args: { accountId: v.string() },
  returns: v.union(v.null(), v.object({ sealedPrivateKey: v.string(), keyVersion: v.number() })),
  handler: async (ctx, { accountId }) => {
    const key = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    return key === null ? null : { sealedPrivateKey: key.sealedPrivateKey, keyVersion: key.keyVersion };
  },
});
