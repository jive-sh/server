import { v } from "convex/values";
import { Effect, pipe } from "effect";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { parseConnectionKey, seal } from "./model/sealing";

/**
 * Connections hold an organization's credentials for an outside system, sealed under `CONNECTION_KEY`. No client
 * can read a credential back.
 *
 * Connecting npm is scaffolding until `connections.create` exists (design doc §3), and is what `bun run
 * connect-npm` drives: a deployment admin asks `openNpmConnectionRequest` (through `convex run`, which carries no
 * secret) for a single-use request id, then sends the credential with that id to `completeNpmConnection` in an
 * HTTPS body, so the token and the authenticator secret never appear on a command line.
 */

/** How long a connection request can be redeemed. */
const REQUEST_MS = 5 * 60 * 1000;

const BASE32 = /^[A-Z2-7]+$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Issues a request to connect the organization's npm account: a random id, of which only the SHA-256 is stored,
 * redeemable once within 5 minutes, and the deployment URL to redeem it at. An action, because only actions get
 * real randomness; queries and mutations are deterministic.
 */
export const openNpmConnectionRequest = internalAction({
  args: { organizationName: v.string() },
  returns: v.object({ requestId: v.string(), deploymentUrl: v.string() }),
  handler: async (ctx, { organizationName }) => {
    const deploymentUrl = process.env.CONVEX_CLOUD_URL;
    if (deploymentUrl === undefined) throw new Error("CONVEX_CLOUD_URL is not set on this deployment");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const requestId = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    await ctx.runMutation(internal.connections.storeNpmConnectionRequest, { organizationName, requestHash: await sha256Hex(requestId) });
    return { requestId, deploymentUrl };
  },
});

export const storeNpmConnectionRequest = internalMutation({
  args: { organizationName: v.string(), requestHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { organizationName, requestHash }) => {
    const organization = await ctx.db.query("organizations").withIndex("by_name", (q) => q.eq("name", organizationName)).unique();
    if (organization === null) throw new Error(`no organization is named ${organizationName}`);
    await ctx.db.insert("connectionRequests", { organizationId: organization._id, connector: "npm", requestHash, expiresAt: Date.now() + REQUEST_MS });
    return null;
  },
});

/** Deletes the request whatever its state, and returns its organization if it was unexpired. */
export const redeemNpmConnectionRequest = internalMutation({
  args: { requestHash: v.string() },
  returns: v.union(v.null(), v.id("organizations")),
  handler: async (ctx, { requestHash }) => {
    const request = await ctx.db.query("connectionRequests").withIndex("by_request_hash", (q) => q.eq("requestHash", requestHash)).unique();
    if (request === null) return null;
    await ctx.db.delete(request._id);
    return request.expiresAt > Date.now() ? request.organizationId : null;
  },
});

/**
 * Stores the organization's npm account, sealed: its token and its authenticator-app secret (base32, as npm's
 * two-factor setup shows it). Public, but it acts only with an unexpired request id from
 * `openNpmConnectionRequest`, which it spends. Replaces any npm connection the organization had. Never logs or
 * returns the credential.
 */
export const completeNpmConnection = action({
  args: { requestId: v.string(), token: v.string(), totpSecret: v.string() },
  returns: v.null(),
  handler: async (ctx, { requestId, token, totpSecret }) => {
    const organizationId = await ctx.runMutation(internal.connections.redeemNpmConnectionRequest, { requestHash: await sha256Hex(requestId) });
    if (organizationId === null) throw new Error("the connection request is unknown, already used or expired; run connect-npm again");
    if (token.trim() === "") throw new Error("the npm token is empty");
    if (!BASE32.test(totpSecret)) throw new Error("the authenticator secret must be uppercase base32 (A-Z, 2-7) without padding");
    const credential = JSON.stringify({ token, secondFactor: { type: "totp", secret: totpSecret } });
    const { sealedCredential, keyVersion } = await Effect.runPromise(pipe(
      Effect.gen(function* () {
        const key = yield* parseConnectionKey(process.env.CONNECTION_KEY);
        return { sealedCredential: yield* seal(key, credential), keyVersion: key.version };
      }),
      Effect.mapError((e) => new Error(e.message)),
    ));
    await ctx.runMutation(internal.connections.replaceNpmConnection, { organizationId, sealedCredential, keyVersion });
    return null;
  },
});

export const replaceNpmConnection = internalMutation({
  args: { organizationId: v.id("organizations"), sealedCredential: v.string(), keyVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { organizationId, sealedCredential, keyVersion }) => {
    const existing = await ctx.db
      .query("connections")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", organizationId).eq("connector", "npm"))
      .collect();
    for (const connection of existing) await ctx.db.delete(connection._id);
    await ctx.db.insert("connections", { organizationId, connector: "npm", sealedCredential, keyVersion, createdAt: Date.now() });
    return null;
  },
});

/** The organization's npm connection, still sealed; null when it has none. */
export const sealedNpmConnection = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.union(v.null(), v.object({ sealedCredential: v.string(), keyVersion: v.number() })),
  handler: async (ctx, { organizationId }) => {
    const connection = await ctx.db
      .query("connections")
      .withIndex("by_organization_and_connector", (q) => q.eq("organizationId", organizationId).eq("connector", "npm"))
      .unique();
    return connection === null ? null : { sealedCredential: connection.sealedCredential, keyVersion: connection.keyVersion };
  },
});
