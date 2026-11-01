import { ConvexError, v } from "convex/values";
import { Effect, Schema, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type DatabaseReader } from "./_generated/server";
import { resolveSession } from "./model/sessions";

/**
 * Phone approval (Alex, 2026-11-01: "once an account is registered someone can enable phone approval such that
 * authn requests from cli will come to a signed in phone and if i approve on my phone then the session token will
 * be granted to the requestor"):
 *
 * 1. The Jive app on a phone, signed in with the account's passkey, calls `enable` with its Expo push token.
 * 2. A program opening a sign-in request names the account by its last session token (`signInRequests:open`), and
 *    the request is pushed to every approval device of that account (`pushSignInRequest`).
 * 3. Tapping the notification opens the request in the app, whose passkey ceremony approves it through
 *    `auth:signIn`, as the website's does; the program's `claim` then answers with its session.
 *
 * Pushes go through Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/), which
 * delivers to Android through the FCM key EAS holds for the app.
 */

const EXPO_PUSH_TOKEN = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/;
/** The Android notification channel the app creates for sign-in requests, so they ring at high importance. */
export const SIGN_IN_REQUEST_CHANNEL = "sign-in-requests";

const device = v.object({ expoPushToken: v.string(), label: v.string(), createdAt: v.number() });

async function accountOf(db: DatabaseReader, sessionToken: string): Promise<Id<"accounts">> {
  const session = await resolveSession(db, sessionToken);
  if (session === null) throw new ConvexError("Sign in again: this session has expired or was signed out.");
  return session.accountId;
}

/** Turns phone approval on for this phone. A token already registered moves to this account. */
export const enable = mutation({
  args: { sessionToken: v.string(), expoPushToken: v.string(), label: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionToken, expoPushToken, label }) => {
    const accountId = await accountOf(ctx.db, sessionToken);
    if (!EXPO_PUSH_TOKEN.test(expoPushToken)) throw new ConvexError("That is not an Expo push token.");
    const existing = await ctx.db.query("approvalDevices").withIndex("by_expo_push_token", (q) => q.eq("expoPushToken", expoPushToken)).unique();
    const trimmedLabel = label.trim().slice(0, 80) || "Phone";
    if (existing === null) {
      await ctx.db.insert("approvalDevices", { accountId, expoPushToken, label: trimmedLabel, createdAt: Date.now() });
    } else {
      await ctx.db.patch(existing._id, { accountId, label: trimmedLabel });
    }
    return null;
  },
});

/** Turns phone approval off for this phone; a token of another account is left alone. */
export const disable = mutation({
  args: { sessionToken: v.string(), expoPushToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionToken, expoPushToken }) => {
    const accountId = await accountOf(ctx.db, sessionToken);
    const existing = await ctx.db.query("approvalDevices").withIndex("by_expo_push_token", (q) => q.eq("expoPushToken", expoPushToken)).unique();
    if (existing !== null && existing.accountId === accountId) await ctx.db.delete(existing._id);
    return null;
  },
});

/** The account's approval devices; null when the session token opens no live session. */
export const list = query({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), v.array(device)),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session === null) return null;
    const devices = await ctx.db.query("approvalDevices").withIndex("by_account", (q) => q.eq("accountId", session.accountId)).collect();
    return devices.map(({ expoPushToken, label, createdAt }) => ({ expoPushToken, label, createdAt }));
  },
});

export const pushTargets = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.object({ username: v.string(), expoPushTokens: v.array(v.string()) }),
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    const devices = await ctx.db.query("approvalDevices").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
    return { username: account?.username ?? "", expoPushTokens: devices.map((row) => row.expoPushToken) };
  },
});

export const forgetUnregistered = internalMutation({
  args: { expoPushTokens: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { expoPushTokens }) => {
    for (const expoPushToken of expoPushTokens) {
      const row = await ctx.db.query("approvalDevices").withIndex("by_expo_push_token", (q) => q.eq("expoPushToken", expoPushToken)).unique();
      if (row !== null) await ctx.db.delete(row._id);
    }
    return null;
  },
});

const Tickets = Schema.Struct({
  data: Schema.Array(Schema.Struct({
    status: Schema.String,
    details: Schema.optionalKey(Schema.Struct({ error: Schema.optionalKey(Schema.String) })),
  })),
});

/**
 * Pushes one sign-in request to the account's approval devices, at most 100 (Expo's per-request limit), and forgets
 * any token Expo answers `DeviceNotRegistered` for. A push that fails changes nothing else: the request can still be
 * approved on the website.
 */
export const pushSignInRequest = internalAction({
  args: { accountId: v.id("accounts"), requestId: v.string(), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { accountId, requestId, expiresAt }) => {
    const { username, expoPushTokens } = await ctx.runQuery(internal.approvalDevices.pushTargets, { accountId });
    const targets = expoPushTokens.slice(0, 100);
    if (targets.length === 0) return null;
    const ttl = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    const messages = targets.map((to) => ({
      to,
      title: "Sign in to Jive?",
      body: `A program asks to sign in as ${username}. Tap to approve with your passkey.`,
      data: { kind: "signInRequest", requestId },
      priority: "high",
      ttl,
      channelId: SIGN_IN_REQUEST_CHANNEL,
    }));
    // Tests point it at a fake push service.
    const url = process.env.EXPO_PUSH_URL ?? "https://exp.host/--/api/v2/push/send";
    const tickets = await Effect.runPromise(pipe(
      Effect.gen(function* () {
        const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
        const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(url), messages);
        const response = yield* client.execute(HttpClientRequest.setHeader(request, "accept", "application/json"));
        return yield* HttpClientResponse.schemaBodyJson(Tickets)(response);
      }),
      Effect.provide(FetchHttpClient.layer),
    ));
    const unregistered = targets.filter((_, index) => tickets.data[index]?.details?.error === "DeviceNotRegistered");
    if (unregistered.length > 0) await ctx.runMutation(internal.approvalDevices.forgetUnregistered, { expoPushTokens: unregistered });
    return null;
  },
});
