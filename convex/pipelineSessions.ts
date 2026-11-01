import { v } from "convex/values";
import { Effect, Result } from "effect";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { JIVE_API_AUDIENCE } from "./model/githubActions";
import { authorizePipelineCaller } from "./model/pipelineCaller";
import { insertPipelineSession, resolvePipelineSession } from "./model/pipelineSessions";
import { SESSION_TOKEN_PREFIX, mintSecret, sha256Hex } from "./model/tokens";

/**
 * Signing in a code repository's pipeline: a deploy job exchanges its GitHub Actions ID token for a session token,
 * and every later call it makes takes that session token (design doc §4). Convex verifies the token's signature,
 * issuer and audience (`auth.config.ts`) before `signIn` runs; `signIn` checks the claims (§6) and that the
 * repository is registered by its immutable ids.
 */

const pipelineSession = v.object({
  codeRepositoryId: v.id("codeRepositories"),
  organizationId: v.id("organizations"),
  repository: v.object({ owner: v.string(), name: v.string() }),
  environment: v.string(),
  workflowFile: v.string(),
});

/**
 * Called with the job's ID token, audience `https://api.jive.sh`, as the bearer token. `refused` says why; it never
 * repeats the token.
 */
export const signIn = action({
  args: {},
  returns: v.union(
    v.object({ status: v.literal("signedIn"), sessionToken: v.string(), expiresAt: v.number() }),
    v.object({ status: v.literal("refused"), reason: v.string() }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return { status: "refused", reason: `the call carries no GitHub Actions ID token for ${JIVE_API_AUDIENCE}` } as const;
    }
    const authorized = await Effect.runPromise(Effect.result(authorizePipelineCaller(identity)));
    if (Result.isFailure(authorized)) return { status: "refused", reason: authorized.failure.reason } as const;
    const caller = authorized.success;
    const sessionToken = mintSecret(SESSION_TOKEN_PREFIX);
    const opened = await ctx.runMutation(internal.pipelineSessions.open, { caller, tokenHash: await sha256Hex(sessionToken) });
    if (opened === null) {
      return {
        status: "refused",
        reason: `${caller.repository.owner}/${caller.repository.name} (id ${caller.repositoryId}) is not a code repository registered with Jive`,
      } as const;
    }
    console.log(`signed in the ${caller.environment} deploy job of ${caller.repository.owner}/${caller.repository.name}`);
    return { status: "signedIn", sessionToken, expiresAt: opened.expiresAt } as const;
  },
});

export const open = internalMutation({
  args: {
    caller: v.object({
      repositoryId: v.string(),
      repositoryOwnerId: v.string(),
      repository: v.object({ owner: v.string(), name: v.string() }),
      environment: v.string(),
      workflowFile: v.string(),
    }),
    tokenHash: v.string(),
  },
  returns: v.union(v.null(), v.object({ expiresAt: v.number() })),
  handler: async (ctx, args) => {
    const opened = await insertPipelineSession(ctx.db, args);
    if (opened === null) return null;
    await ctx.scheduler.runAt(opened.expiresAt, internal.pipelineSessions.deleteSession, { id: opened.sessionId });
    return { expiresAt: opened.expiresAt };
  },
});

export const deleteSession = internalMutation({
  args: { id: v.id("pipelineSessions") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id) !== null) await ctx.db.delete(id);
    return null;
  },
});

/** The live pipeline session the token opens, or null. */
export const pipeline = internalQuery({
  args: { sessionToken: v.string() },
  returns: v.union(v.null(), pipelineSession),
  handler: async (ctx, { sessionToken }) => await resolvePipelineSession(ctx.db, sessionToken),
});
