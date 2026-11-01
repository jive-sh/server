import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { ConvexError, v } from "convex/values";
import { Effect, Result } from "effect";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { usernameFor } from "./model/naming";
import { SESSION_MS } from "./model/sessions";
import { approveSignInRequest } from "./model/signInRequests";
import { SESSION_TOKEN_PREFIX, mintSecret, sha256Hex } from "./model/tokens";
import {
  authenticationOptions,
  registrationOptions as creationOptions,
  relyingPartyOf,
  verifyAuthentication,
  verifyRegistration,
  type CeremonyFailed,
  type WebsiteDomainMissing,
} from "./model/webAuthn";

/**
 * Passkey registration and sign-in for people, relying party `jive.sh`. Each ceremony is two calls: options,
 * then the browser's response, which opens a session and returns its token once. Either may also approve a
 * program's sign-in request (`signInRequestId`), so the program claims a session of its own from the same
 * passkey touch (`signInRequests.ts`).
 *
 * Ceremonies are verified in actions, since they need Web Crypto and randomness; everything they record is
 * written by one internal mutation, so a session never exists without the account and passkey behind it.
 */

/** How long a challenge can be answered: far longer than a ceremony takes, too short to be worth capturing. */
const CHALLENGE_MS = 5 * 60 * 1000;

const sessionOpened = v.object({ sessionToken: v.string(), expiresAt: v.number(), username: v.string() });

/** Runs a model effect, turning a failed ceremony into a ConvexError whose message the page shows. */
async function run<A>(effect: Effect.Effect<A, CeremonyFailed | WebsiteDomainMissing>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return result.success;
  throw result.failure._tag === "CeremonyFailed" ? new ConvexError(result.failure.message) : new Error(result.failure.message);
}

const relyingParty = () => run(relyingPartyOf(process.env.WEBSITE_DOMAIN));

export const registrationOptions = action({
  args: {},
  returns: v.object({ options: v.any() }),
  handler: async (ctx) => {
    const party = await relyingParty();
    // The user handle is drawn before the account exists, because the authenticator stores it and the handle is
    // derived from it. A derived handle can collide, so a fresh one is drawn while it is taken.
    let webAuthnUserId = crypto.randomUUID();
    for (let attempt = 0; attempt < 8 && await ctx.runQuery(internal.auth.usernameTaken, { username: usernameFor(webAuthnUserId) }); attempt += 1) {
      webAuthnUserId = crypto.randomUUID();
    }
    const username = usernameFor(webAuthnUserId);
    if (await ctx.runQuery(internal.auth.usernameTaken, { username })) throw new Error("could not derive a free handle for a new account");
    const challenge = mintSecret("");
    await ctx.runMutation(internal.auth.storeChallenge, {
      challengeHash: await sha256Hex(challenge),
      purpose: "registration",
      registration: { webAuthnUserId, username },
    });
    return { options: await run(creationOptions({ relyingParty: party, challenge, webAuthnUserId, username })) };
  },
});

/** Creates the account and its passkey from the browser's registration response, and opens its first session. */
export const register = action({
  args: { challenge: v.string(), response: v.any(), signInRequestId: v.optional(v.string()) },
  returns: sessionOpened,
  handler: async (ctx, { challenge, response, signInRequestId }) => {
    const party = await relyingParty();
    const spent = await ctx.runMutation(internal.auth.spendChallenge, { challengeHash: await sha256Hex(challenge), purpose: "registration" });
    if (spent === null || spent.registration === undefined) throw new ConvexError("This passkey prompt expired. Try again.");
    const passkey = await run(verifyRegistration({ relyingParty: party, challenge, response: response as RegistrationResponseJSON }));
    const sessionToken = mintSecret(SESSION_TOKEN_PREFIX);
    const { expiresAt } = await ctx.runMutation(internal.auth.createAccount, {
      ...spent.registration,
      ...passkey,
      tokenHash: await sha256Hex(sessionToken),
      signInRequestId,
    });
    return { sessionToken, expiresAt, username: spent.registration.username };
  },
});

export const signInOptions = action({
  args: {},
  returns: v.object({ options: v.any() }),
  handler: async (ctx) => {
    const party = await relyingParty();
    const challenge = mintSecret("");
    await ctx.runMutation(internal.auth.storeChallenge, { challengeHash: await sha256Hex(challenge), purpose: "signIn" });
    return { options: await run(authenticationOptions({ relyingParty: party, challenge })) };
  },
});

/** Verifies the browser's assertion against the passkey it names and opens a session for that passkey's account. */
export const signIn = action({
  args: { challenge: v.string(), response: v.any(), signInRequestId: v.optional(v.string()) },
  returns: sessionOpened,
  handler: async (ctx, { challenge, response, signInRequestId }) => {
    const party = await relyingParty();
    const spent = await ctx.runMutation(internal.auth.spendChallenge, { challengeHash: await sha256Hex(challenge), purpose: "signIn" });
    if (spent === null) throw new ConvexError("This passkey prompt expired. Try again.");
    const credentialId = typeof response?.id === "string" ? response.id : "";
    const passkey = await ctx.runQuery(internal.auth.passkeyByCredentialId, { credentialId });
    // The same answer as a bad signature: whether a passkey is registered is not for an anonymous caller to learn.
    if (passkey === null) throw new ConvexError("That passkey is not registered with Jive.");
    await run(verifyAuthentication({ relyingParty: party, challenge, response: response as AuthenticationResponseJSON, passkey }));
    const sessionToken = mintSecret(SESSION_TOKEN_PREFIX);
    const opened = await ctx.runMutation(internal.auth.openSession, {
      accountId: passkey.accountId,
      tokenHash: await sha256Hex(sessionToken),
      signInRequestId,
    });
    return { sessionToken, ...opened };
  },
});

export const usernameTaken = internalQuery({
  args: { username: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { username }) =>
    await ctx.db.query("accounts").withIndex("by_username", (q) => q.eq("username", username)).first() !== null,
});

export const storeChallenge = internalMutation({
  args: {
    challengeHash: v.string(),
    purpose: v.union(v.literal("registration"), v.literal("signIn")),
    registration: v.optional(v.object({ webAuthnUserId: v.string(), username: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const expiresAt = Date.now() + CHALLENGE_MS;
    const id = await ctx.db.insert("webAuthnChallenges", { ...args, expiresAt });
    await ctx.scheduler.runAt(expiresAt, internal.auth.deleteChallenge, { id });
    return null;
  },
});

export const deleteChallenge = internalMutation({
  args: { id: v.id("webAuthnChallenges") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id) !== null) await ctx.db.delete(id);
    return null;
  },
});

/**
 * Deletes the challenge whatever happens next, so a failed attempt burns it too, and returns it if it was
 * unexpired and issued for this purpose.
 */
export const spendChallenge = internalMutation({
  args: { challengeHash: v.string(), purpose: v.union(v.literal("registration"), v.literal("signIn")) },
  returns: v.union(v.null(), v.object({ registration: v.optional(v.object({ webAuthnUserId: v.string(), username: v.string() })) })),
  handler: async (ctx, { challengeHash, purpose }) => {
    const challenge = await ctx.db.query("webAuthnChallenges").withIndex("by_challenge_hash", (q) => q.eq("challengeHash", challengeHash)).unique();
    if (challenge === null) return null;
    await ctx.db.delete(challenge._id);
    if (challenge.expiresAt <= Date.now() || challenge.purpose !== purpose) return null;
    return challenge.registration === undefined ? {} : { registration: challenge.registration };
  },
});

export const passkeyByCredentialId = internalQuery({
  args: { credentialId: v.string() },
  returns: v.union(v.null(), v.object({ accountId: v.id("accounts"), credentialId: v.string(), publicKey: v.string() })),
  handler: async (ctx, { credentialId }) => {
    const passkey = await ctx.db.query("passkeys").withIndex("by_credential_id", (q) => q.eq("credentialId", credentialId)).unique();
    return passkey === null ? null : { accountId: passkey.accountId, credentialId: passkey.credentialId, publicKey: passkey.publicKey };
  },
});

async function insertSession(ctx: MutationCtx, input: {
  readonly accountId: Id<"accounts">;
  readonly tokenHash: string;
  readonly signInRequestId: string | undefined;
}): Promise<{ readonly expiresAt: number }> {
  if (input.signInRequestId !== undefined) await approveSignInRequest(ctx, { requestId: input.signInRequestId, accountId: input.accountId });
  const now = Date.now();
  const expiresAt = now + SESSION_MS;
  await ctx.db.insert("sessions", { accountId: input.accountId, tokenHash: input.tokenHash, origin: "browser", createdAt: now, expiresAt });
  return { expiresAt };
}

/** Account, passkey and session in one transaction: an account without its passkey could never be signed in to. */
export const createAccount = internalMutation({
  args: {
    webAuthnUserId: v.string(),
    username: v.string(),
    credentialId: v.string(),
    publicKey: v.string(),
    tokenHash: v.string(),
    signInRequestId: v.optional(v.string()),
  },
  returns: v.object({ expiresAt: v.number() }),
  handler: async (ctx, { webAuthnUserId, username, credentialId, publicKey, tokenHash, signInRequestId }) => {
    if (await ctx.db.query("accounts").withIndex("by_username", (q) => q.eq("username", username)).first() !== null) {
      throw new ConvexError(`The handle ${username} was taken meanwhile. Try again.`);
    }
    if (await ctx.db.query("passkeys").withIndex("by_credential_id", (q) => q.eq("credentialId", credentialId)).first() !== null) {
      throw new ConvexError("That passkey is already registered. Sign in instead.");
    }
    const now = Date.now();
    const accountId = await ctx.db.insert("accounts", { username, webAuthnUserId, createdAt: now });
    await ctx.db.insert("passkeys", { accountId, credentialId, publicKey, createdAt: now });
    return await insertSession(ctx, { accountId, tokenHash, signInRequestId });
  },
});

export const openSession = internalMutation({
  args: { accountId: v.id("accounts"), tokenHash: v.string(), signInRequestId: v.optional(v.string()) },
  returns: v.object({ expiresAt: v.number(), username: v.string() }),
  handler: async (ctx, { accountId, tokenHash, signInRequestId }) => {
    const account = await ctx.db.get(accountId);
    if (account === null) throw new ConvexError("That passkey is not registered with Jive.");
    const { expiresAt } = await insertSession(ctx, { accountId, tokenHash, signInRequestId });
    return { expiresAt, username: account.username };
  },
});
