import { v } from "convex/values";
import { query } from "./_generated/server";
import { resolveSession } from "./model/sessions";

/**
 * The signed-in person's account and passkeys, and when the presented session ends unless it is used before then
 * (`sessionExpiresAt`: each use moves it, so a copy a client kept from sign-in goes stale); null when the session
 * token opens no live session. A query, so asking does not extend the session.
 */
export const me = query({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), v.object({
    username: v.string(),
    createdAt: v.number(),
    sessionExpiresAt: v.number(),
    passkeys: v.array(v.object({ credentialId: v.string(), createdAt: v.number() })),
  })),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session === null) return null;
    const account = await ctx.db.get(session.accountId);
    if (account === null) return null;
    const passkeys = await ctx.db.query("passkeys").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    return {
      username: account.username,
      createdAt: account.createdAt,
      sessionExpiresAt: session.expiresAt,
      passkeys: passkeys.map((passkey) => ({ credentialId: passkey.credentialId, createdAt: passkey.createdAt })),
    };
  },
});
