import { v } from "convex/values";
import { Effect } from "effect";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, query, type DatabaseReader } from "./_generated/server";
import { insertAccountSession } from "./model/sessions";
import { SIGN_IN_REQUEST_MS } from "./model/signInRequests";
import { CLAIM_SECRET_PREFIX, SESSION_TOKEN_PREFIX, mintSecret, sha256Hex } from "./model/tokens";
import { relyingPartyOf } from "./model/webAuthn";

/**
 * Signing in a program on a person's machine (a CLI or the Jive daemon), which holds no passkey and opens no
 * page of its own:
 *
 * 1. The program calls `open` and keeps the claim secret, which only it ever holds.
 * 2. The person opens `loginUrl` (`https://jive.sh/login?request=<id>`) and signs in or registers with a passkey;
 *    that ceremony approves the request (`auth.ts`). There is no code to compare (Alex, 2026-11-01: "a human just
 *    signs in with the passkey. none of this code bullshit").
 * 3. The program calls `claim` with the claim secret until it answers `approved`, with a session token of the
 *    program's own; a request is claimed once.
 *
 * Nothing passes through the page to the program, and the browser's session and the program's are separate.
 * Every call is plain Convex, so a program reaches them with `ConvexHttpClient` or `POST /api/action`.
 */

export const open = action({
  args: {
    /**
     * The program's last session token, expired or not, which names the account whose approval devices the
     * request is pushed to (`approvalDevices.ts`). A revoked or unknown token pushes to nobody. A handle would not
     * do: anyone knowing it could send that person approval prompts, and one mistaken tap would hand them a session.
     */
    previousSessionToken: v.optional(v.string()),
  },
  returns: v.object({
    requestId: v.string(),
    claimSecret: v.string(),
    loginUrl: v.string(),
    expiresAt: v.number(),
    /** How many phones the request was pushed to, so the program can say to approve it there. */
    approvalDevices: v.number(),
  }),
  handler: async (ctx, { previousSessionToken }) => {
    const relyingParty = await Effect.runPromise(relyingPartyOf(process.env.WEBSITE_DOMAIN));
    const claimSecret = mintSecret(CLAIM_SECRET_PREFIX);
    const { requestId, expiresAt, approvalDevices } = await ctx.runMutation(internal.signInRequests.store, {
      claimSecretHash: await sha256Hex(claimSecret),
      ...(previousSessionToken === undefined ? {} : { previousSessionTokenHash: await sha256Hex(previousSessionToken) }),
    });
    return { requestId, claimSecret, loginUrl: `${relyingParty.origin}/login?request=${requestId}`, expiresAt, approvalDevices };
  },
});

export const store = internalMutation({
  args: { claimSecretHash: v.string(), previousSessionTokenHash: v.optional(v.string()) },
  returns: v.object({ requestId: v.string(), expiresAt: v.number(), approvalDevices: v.number() }),
  handler: async (ctx, { claimSecretHash, previousSessionTokenHash }) => {
    const expiresAt = Date.now() + SIGN_IN_REQUEST_MS;
    const id = await ctx.db.insert("signInRequests", { claimSecretHash, expiresAt });
    // Anyone may open a request, so each is deleted when it expires. An unclaimed one granted nothing.
    await ctx.scheduler.runAt(expiresAt, internal.signInRequests.deleteRequest, { id });
    const maybeAccountId = previousSessionTokenHash === undefined ? undefined : await accountOfPreviousSession(ctx.db, previousSessionTokenHash);
    if (maybeAccountId === undefined) return { requestId: id, expiresAt, approvalDevices: 0 };
    const devices = await ctx.db.query("approvalDevices").withIndex("by_account", (q) => q.eq("accountId", maybeAccountId)).collect();
    if (devices.length > 0) {
      await ctx.scheduler.runAfter(0, internal.approvalDevices.pushSignInRequest, { accountId: maybeAccountId, requestId: id, expiresAt });
    }
    return { requestId: id, expiresAt, approvalDevices: devices.length };
  },
});

/** The account a session token was issued to, expired or not; undefined when it is unknown or was revoked. */
async function accountOfPreviousSession(db: DatabaseReader, tokenHash: string): Promise<Id<"accounts"> | undefined> {
  const session = await db.query("sessions").withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
  return session === null || session.revokedAt !== undefined ? undefined : session.accountId;
}

export const deleteRequest = internalMutation({
  args: { id: v.id("signInRequests") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id) !== null) await ctx.db.delete(id);
    return null;
  },
});

/** Whether the request the login page names is still pending; null when it is unknown, expired or claimed. */
export const describe = query({
  args: { requestId: v.string() },
  returns: v.union(v.null(), v.object({ status: v.union(v.literal("pending"), v.literal("approved")) })),
  handler: async (ctx, { requestId }) => {
    const id = ctx.db.normalizeId("signInRequests", requestId);
    const request = id === null ? null : await ctx.db.get(id);
    if (request === null || request.claimedAt !== undefined || request.expiresAt <= Date.now()) return null;
    return { status: request.approvedAccountId === undefined ? "pending" : "approved" } as const;
  },
});

/**
 * The program asks whether its request was approved. `gone` covers unknown, expired, already claimed and a wrong
 * claim secret alike, so a guesser learns nothing.
 */
export const claim = action({
  args: { requestId: v.string(), claimSecret: v.string() },
  returns: v.union(
    v.object({ status: v.literal("pending") }),
    v.object({ status: v.literal("approved"), sessionToken: v.string(), expiresAt: v.number() }),
    v.object({ status: v.literal("gone") }),
  ),
  handler: async (ctx, { requestId, claimSecret }) => {
    const sessionToken = mintSecret(SESSION_TOKEN_PREFIX);
    const outcome = await ctx.runMutation(internal.signInRequests.claimWithToken, {
      requestId,
      claimSecretHash: await sha256Hex(claimSecret),
      tokenHash: await sha256Hex(sessionToken),
    });
    return outcome.status === "approved" ? { status: "approved", sessionToken, expiresAt: outcome.expiresAt } as const : outcome;
  },
});

/** Marks the request claimed and opens the program's session in one transaction, so a request yields one session. */
export const claimWithToken = internalMutation({
  args: { requestId: v.string(), claimSecretHash: v.string(), tokenHash: v.string() },
  returns: v.union(
    v.object({ status: v.literal("pending") }),
    v.object({ status: v.literal("approved"), expiresAt: v.number() }),
    v.object({ status: v.literal("gone") }),
  ),
  handler: async (ctx, { requestId, claimSecretHash, tokenHash }) => {
    const id = ctx.db.normalizeId("signInRequests", requestId);
    const request = id === null ? null : await ctx.db.get(id);
    const now = Date.now();
    if (request === null || request.claimSecretHash !== claimSecretHash || request.claimedAt !== undefined || request.expiresAt <= now) {
      return { status: "gone" } as const;
    }
    if (request.approvedAccountId === undefined) return { status: "pending" } as const;
    // The account is read again at claim time: one deleted since approving gets no session.
    if (await ctx.db.get(request.approvedAccountId) === null) return { status: "gone" } as const;
    await ctx.db.patch(request._id, { claimedAt: now });
    const { expiresAt } = await insertAccountSession(ctx.db, { accountId: request.approvedAccountId, tokenHash, origin: "signInRequest" });
    return { status: "approved", expiresAt } as const;
  },
});
