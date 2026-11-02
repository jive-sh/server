import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalQuery, query, type ActionCtx } from "./_generated/server";
import { resolveSession } from "./model/sessions";

/**
 * Signing with the account's SSH key on the server (Alex, 2026-11-01: "There's just an ssh sign request. You don't
 * create keys. You can fetch the public key or sign"). The public API is `publicKey` and `sign`. Every account has its
 * key from sign-up (`ensureAccountKey`, called by `auth:register`), and the deploy gives one to any account without
 * (`afterDeploy`). The key is held by the accountKeys component; these functions check the session, then call it.
 * Every call resolves the session first, so a revoked or expired session signs nothing.
 */

const NOT_SIGNED_IN = "The session token opens no live session. Sign in again.";

/** The account's OpenSSH public key (`ssh-ed25519 … <handle>@jive.sh`). */
export const publicKey = query({
  args: { sessionToken: v.string() },
  returns: v.object({ publicKey: v.string() }),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session === null) throw new ConvexError(NOT_SIGNED_IN);
    const key = await ctx.runQuery(components.accountKeys.ssh.publicKey, { accountId: session.accountId });
    // Every account gets its key at sign-up or from the deploy, so none should be missing; say so if one is.
    if (key === null) throw new Error(`account ${session.accountId} has no SSH key; the next deploy creates it`);
    return key;
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
 * Makes sure the account has its SSH key, creating it when it has none: the component's `createKey` is idempotent.
 * Called by `auth:register` before it returns, so a new account has its key from its first session.
 */
export async function ensureAccountKey(ctx: ActionCtx, account: { readonly accountId: Id<"accounts">; readonly username: string }): Promise<void> {
  await ctx.runAction(components.accountKeys.ssh.createKey, { accountId: account.accountId, username: account.username });
}

/** `ensureAccountKey` for a mutation that creates an account (`seed:accountWithPasskey`), which schedules it. */
export const ensureKey = internalAction({
  args: { accountId: v.id("accounts"), username: v.string() },
  returns: v.null(),
  handler: async (ctx, account) => {
    await ensureAccountKey(ctx, account);
    return null;
  },
});

/** Every account, for the deploy's backfill. */
export const accounts = internalQuery({
  args: {},
  returns: v.array(v.object({ accountId: v.id("accounts"), username: v.string() })),
  handler: async (ctx) => (await ctx.db.query("accounts").collect()).map((account) => ({ accountId: account._id, username: account.username })),
});

/**
 * Run by the deploy after the push (`backend-convex.afterDeploy`), with the commit and the environment the hook passes:
 * gives every account that has no SSH key one. Running it again creates nothing.
 */
export const afterDeploy = internalAction({
  args: { sourceCommitSha: v.string(), environment: v.string() },
  returns: v.object({ accounts: v.number(), created: v.number() }),
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.ssh.accounts, {});
    let created = 0;
    for (const account of accounts) {
      if (await ctx.runQuery(components.accountKeys.ssh.publicKey, { accountId: account.accountId }) !== null) continue;
      await ensureAccountKey(ctx, account);
      created += 1;
    }
    return { accounts: accounts.length, created };
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
