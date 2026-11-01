import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query, type ActionCtx } from "./_generated/server";
import { resolveSession } from "./model/sessions";

/**
 * Signing with the account's SSH key on the server (Alex, 2026-11-01: "a ssh signing request paired with a session
 * token would have jive internally load the ssh key and sign the request ... the ssh key is no longer stored client
 * side"). The key is held by the accountKeys component, one per account. These functions check the session, then
 * call the component. `sign` takes a session token and the bytes to sign and returns the SSH signature.
 *
 * Every call resolves the session first, so a revoked or expired session signs nothing.
 */

const NOT_SIGNED_IN = "The session token opens no live session. Sign in again.";

/** The account's public key, creating the key on the first call. Idempotent: one key per account. */
export const createKey = action({
  args: { sessionToken: v.string() },
  returns: v.object({ publicKey: v.string() }),
  handler: async (ctx, { sessionToken }) => {
    const caller = await ctx.runQuery(internal.ssh.caller, { sessionToken });
    if (caller === null) throw new ConvexError(NOT_SIGNED_IN);
    await copyLegacyKey(ctx, caller.accountId);
    return await ctx.runAction(components.accountKeys.ssh.createKey, { accountId: caller.accountId, username: caller.username });
  },
});

/** The account's OpenSSH public key, or null before `createKey`. */
export const publicKey = query({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), v.object({ publicKey: v.string() })),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session === null) throw new ConvexError(NOT_SIGNED_IN);
    return await ctx.runQuery(components.accountKeys.ssh.publicKey, { accountId: session.accountId });
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
    const session = await ctx.runQuery(internal.ssh.caller, { sessionToken });
    if (session === null) throw new ConvexError(NOT_SIGNED_IN);
    await copyLegacyKey(ctx, session.accountId);
    return await ctx.runAction(components.accountKeys.ssh.sign, { accountId: session.accountId, data });
  },
});

/** Who the session belongs to; null when the session is not live. */
export const caller = internalQuery({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), v.object({ accountId: v.id("accounts"), username: v.string() })),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    const account = session === null ? null : await ctx.db.get(session.accountId);
    if (account === null) return null;
    return { accountId: account._id, username: account.username };
  },
});

/**
 * Copies this account's pre-component key, still sealed, when the component has none. A component key with a
 * different public key fails the copy, so `createKey` never mints a second one over it.
 */
async function copyLegacyKey(ctx: ActionCtx, accountId: Id<"accounts">): Promise<void> {
  const legacy = await ctx.runQuery(internal.ssh.legacyKey, { accountId });
  if (legacy === null) return;
  await ctx.runMutation(components.accountKeys.ssh.importExisting, { accountId, ...legacy });
}

/** The key this account had before the component, or null. The ciphertext, never the opened key. */
export const legacyKey = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.union(v.null(), v.object({
    publicKey: v.string(),
    sealedPrivateKey: v.string(),
    keyVersion: v.number(),
    createdAt: v.number(),
  })),
  handler: async (ctx, { accountId }) => {
    const key = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    if (key === null) return null;
    return {
      publicKey: key.publicKey,
      sealedPrivateKey: key.sealedPrivateKey,
      keyVersion: key.keyVersion,
      createdAt: key.createdAt,
    };
  },
});

/**
 * Copies every pre-component SSH key into accountKeys. The deploy runs this after the push, with the commit and
 * the environment the hook passes. Running it again copies nothing that is already there.
 */
export const migrateToAccountKeys = internalMutation({
  args: { sourceCommitSha: v.string(), environment: v.string() },
  returns: v.object({ copied: v.number(), alreadyPresent: v.number() }),
  handler: async (ctx, _args) => {
    const rows = await ctx.db.query("sshKeys").collect();
    let copied = 0;
    let alreadyPresent = 0;
    for (const row of rows) {
      const outcome = await ctx.runMutation(components.accountKeys.ssh.importExisting, {
        accountId: row.accountId,
        publicKey: row.publicKey,
        sealedPrivateKey: row.sealedPrivateKey,
        keyVersion: row.keyVersion,
        createdAt: row.createdAt,
      });
      if (outcome === "copied") copied += 1;
      else alreadyPresent += 1;
    }
    return { copied, alreadyPresent };
  },
});

/**
 * A row of the shape production stored before the component. The test inserts one; the product writes no new rows
 * here.
 */
export const insertLegacy = internalMutation({
  args: {
    accountId: v.id("accounts"),
    publicKey: v.string(),
    sealedPrivateKey: v.string(),
    keyVersion: v.number(),
    createdAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (existing !== null) throw new Error("this account already has a legacy SSH key");
    await ctx.db.insert("sshKeys", args);
    return null;
  },
});

/**
 * Removes the pre-component row the test planted. A deliberate mismatch must not stay in the shared local backend,
 * or the next migration fails on it. The product never deletes these rows.
 */
export const removeLegacy = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }) => {
    const existing = await ctx.db.query("sshKeys").withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    if (existing !== null) await ctx.db.delete(existing._id);
    return null;
  },
});

/** The session's sealed key; null when the session is not live, `sealed: null` when the account has no key. */
export const sealedKey = internalQuery({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), v.object({ sealed: v.union(v.null(), v.object({ sealedPrivateKey: v.string(), keyVersion: v.number() })) })),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session === null) return null;
    const sealed = await ctx.runQuery(components.accountKeys.ssh.sealed, { accountId: session.accountId });
    return { sealed };
  },
});
