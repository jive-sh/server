import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action, internalQuery, query } from "./_generated/server";
import { resolveSession } from "./model/sessions";

/**
 * The organization's npm connection, opened only for a live Jive session that names a registered code repository.
 * The sk-demo daemon saves the registry token after a person with that organization's npm access signs in in a
 * browser. The token is sealed in the accountKeys component, one per organization, connector `npm`.
 */

const NOT_SIGNED_IN = "The session token opens no live session. Sign in again.";
const NOT_REGISTERED = "This repository is not registered to an organization.";
const NO_CONNECTION = "This organization has no npm connection yet.";

const repositoryArgs = {
  sessionToken: v.string(),
  repositoryOwner: v.string(),
  repositoryName: v.string(),
};

/** Whether this organization's npm connection has a token, and whether npm has accepted the signing passkey. */
export const status = query({
  args: repositoryArgs,
  returns: v.object({ hasToken: v.boolean(), passkeyRegistered: v.boolean() }),
  handler: async (ctx, args) => {
    const organizationId = await ctx.runQuery(internal.npmSessions.organizationForRepository, args);
    if (organizationId === null) throw new ConvexError(NOT_SIGNED_IN);
    return await ctx.runQuery(components.accountKeys.npmConnection.status, { organizationId });
  },
});

/** Seals and stores the npm registry token for the repository's organization, replacing one already stored. */
export const save = action({
  args: { ...repositoryArgs, token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token, ...repository }) => {
    const organizationId = await ctx.runQuery(internal.npmSessions.organizationForRepository, repository);
    if (organizationId === null) throw new ConvexError(NOT_SIGNED_IN);
    await ctx.runAction(components.accountKeys.npmConnection.save, { organizationId, token });
    return null;
  },
});

/** The npm registry token, for a live session whose organization has one stored. */
export const token = action({
  args: repositoryArgs,
  returns: v.object({ token: v.string() }),
  handler: async (ctx, repository) => {
    const organizationId = await ctx.runQuery(internal.npmSessions.organizationForRepository, repository);
    if (organizationId === null) throw new ConvexError(NOT_SIGNED_IN);
    const stored = await ctx.runAction(components.accountKeys.npmConnection.token, { organizationId });
    if (stored === null) throw new ConvexError(NO_CONNECTION);
    return stored;
  },
});

/** Records that npm accepted the organization's signing passkey, so later publishes do not open a browser. */
export const markPasskeyRegistered = action({
  args: repositoryArgs,
  returns: v.null(),
  handler: async (ctx, repository) => {
    const organizationId = await ctx.runQuery(internal.npmSessions.organizationForRepository, repository);
    if (organizationId === null) throw new ConvexError(NOT_SIGNED_IN);
    await ctx.runMutation(components.accountKeys.npmConnection.markRegistered, { organizationId });
    return null;
  },
});

/**
 * The organization that owns this code repository, or null when the session is not live. A repository Jive has
 * not registered is a setup failure, not a dead session.
 */
export const organizationForRepository = internalQuery({
  args: repositoryArgs,
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { sessionToken, repositoryOwner, repositoryName }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session === null) return null;
    const repository = await ctx.db
      .query("codeRepositories")
      .filter((q) => q.and(q.eq(q.field("owner"), repositoryOwner), q.eq(q.field("name"), repositoryName)))
      .unique();
    if (repository === null) throw new ConvexError(NOT_REGISTERED);
    return repository.organizationId;
  },
});
