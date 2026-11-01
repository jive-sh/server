import { ConvexError, v } from "convex/values";
import { Effect, pipe } from "effect";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { openWithDeploymentKey, sealWithDeploymentKey } from "./model/sealing";
import { resolveSession } from "./model/sessions";
import { generateSshKey, signWithSshKey } from "./model/sshKeys";

/**
 * Signing with the account's SSH key on the server (Alex, 2026-11-01: "a ssh signing request paired with a session
 * token would have jive internally load the ssh key and sign the request ... the ssh key is no longer stored client
 * side"). The key is made once per account by `createKey`; `sign` takes a session token and the bytes to sign and
 * returns the SSH signature, so a local SSH agent holds no key and forwards each sign request here. Git commit
 * signing (`ssh-keygen -Y sign` over the agent) and SSH authentication are both such requests.
 *
 * Every call resolves the session first, so a revoked or expired session signs nothing.
 */

const NOT_SIGNED_IN = "The session token opens no live session. Sign in again.";

const sealedFailure = (e: { readonly message: string }) => new Error(`the account's SSH key: ${e.message}`);

/** The account's public key, creating the key on the first call. Idempotent: one key per account. */
export const createKey = action({
  args: { sessionToken: v.string() },
  returns: v.object({ publicKey: v.string() }),
  handler: async (ctx, { sessionToken }) => {
    const caller = await ctx.runQuery(internal.ssh.caller, { sessionToken });
    if (caller === null) throw new ConvexError(NOT_SIGNED_IN);
    if (caller.publicKey !== null) return { publicKey: caller.publicKey };
    const generated = await generateSshKey(`${caller.username}@jive.sh`);
    const { sealed, keyVersion } = await Effect.runPromise(pipe(sealWithDeploymentKey(generated.privateKeyPkcs8), Effect.mapError(sealedFailure)));
    const publicKey = await ctx.runMutation(internal.ssh.storeKey, {
      accountId: caller.accountId,
      publicKey: generated.publicKey,
      sealedPrivateKey: sealed,
      keyVersion,
    });
    return { publicKey };
  },
});

/** The account's OpenSSH public key, or null before `createKey`. */
export const publicKey = query({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), v.object({ publicKey: v.string() })),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session === null) throw new ConvexError(NOT_SIGNED_IN);
    const key = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", session.accountId)).unique();
    return key === null ? null : { publicKey: key.publicKey };
  },
});

/**
 * Signs `data` with the account's SSH key and returns the signature in SSH's encoding (`string "ssh-ed25519" ||
 * string <64-byte signature>`), what an agent puts in `SSH_AGENT_SIGN_RESPONSE`. The server does not read `data`.
 */
export const sign = action({
  args: { sessionToken: v.string(), data: v.bytes() },
  returns: v.object({ signature: v.bytes() }),
  handler: async (ctx, { sessionToken, data }) => {
    const key = await ctx.runQuery(internal.ssh.sealedKey, { sessionToken });
    if (key === null) throw new ConvexError(NOT_SIGNED_IN);
    if (key.sealed === null) throw new ConvexError("This account has no SSH key yet. Create one first.");
    const privateKeyPkcs8 = await Effect.runPromise(pipe(
      openWithDeploymentKey({ sealed: key.sealed.sealedPrivateKey, keyVersion: key.sealed.keyVersion }),
      Effect.mapError(sealedFailure),
    ));
    const signature = await signWithSshKey(privateKeyPkcs8, new Uint8Array(data));
    return { signature: signature.buffer };
  },
});

/** Who the session belongs to, and their public key if they have one; null when the session is not live. */
export const caller = internalQuery({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), v.object({ accountId: v.id("accounts"), username: v.string(), publicKey: v.union(v.null(), v.string()) })),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    const account = session === null ? null : await ctx.db.get(session.accountId);
    if (account === null) return null;
    const key = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", account._id)).unique();
    return { accountId: account._id, username: account.username, publicKey: key === null ? null : key.publicKey };
  },
});

/** Stores the key unless one was stored meanwhile, and returns the public key the account ends up with. */
export const storeKey = internalMutation({
  args: { accountId: v.id("accounts"), publicKey: v.string(), sealedPrivateKey: v.string(), keyVersion: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (existing !== null) return existing.publicKey;
    await ctx.db.insert("sshKeys", { ...args, createdAt: Date.now() });
    return args.publicKey;
  },
});

/** The session's sealed key; null when the session is not live, `sealed: null` when the account has no key. */
export const sealedKey = internalQuery({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), v.object({ sealed: v.union(v.null(), v.object({ sealedPrivateKey: v.string(), keyVersion: v.number() })) })),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session === null) return null;
    const key = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", session.accountId)).unique();
    return { sealed: key === null ? null : { sealedPrivateKey: key.sealedPrivateKey, keyVersion: key.keyVersion } };
  },
});
