import { v } from "convex/values";
import { Effect, pipe } from "effect";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { parseConnectionKey, seal } from "./model/sealing";

/**
 * Connections hold an organization's credentials for an outside system, sealed under `CONNECTION_KEY`. Only
 * internal functions touch them: no client can read a credential back.
 */

/**
 * Connects an organization's npm account: its token and the authenticator-app secret npm's two-factor setup
 * showed (base32). Scaffolding until `connections.create` exists (design doc §3): run by a person with
 * `convex run connections:connectNpm`, and listed in skill-sync's `docs/lacking-durable-workflows.md`. Replaces
 * any npm connection the organization had.
 */
export const connectNpm = internalAction({
  args: { organizationId: v.id("organizations"), token: v.string(), totpSecret: v.string() },
  returns: v.null(),
  handler: async (ctx, { organizationId, token, totpSecret }) => {
    const credential = JSON.stringify({ token, secondFactor: { type: "totp", secret: totpSecret } });
    const { sealedCredential, keyVersion } = await Effect.runPromise(pipe(Effect.gen(function* () {
      const key = yield* parseConnectionKey(process.env.CONNECTION_KEY);
      return { sealedCredential: yield* seal(key, credential), keyVersion: key.version };
    }), Effect.mapError((e) => new Error(e.message))));
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
