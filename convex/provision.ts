import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery, type ActionCtx } from "./_generated/server";
import { RESOURCE_KINDS, resourceKindNamed, type ProvisionResult } from "./model/resourceKinds";
import { resolveSession } from "./model/sessions";

/**
 * `provision`: "make sure this resource instance exists" (Alex, 2026-11-01: "the api is provision"). The default
 * export, so callers name it `provision` over the HTTP API and `api.provision.default` from the typed client. The
 * caller names the kind and the instance; the organization's one configured implementation of that kind does the
 * work. Contract: `packages/@jive-sh/jive/docs/jive_server_provision_api.md` in the chaine monorepo.
 */

export const provisionResult = v.union(
  v.object({ status: v.literal("ready"), instanceId: v.string(), instance: v.any() }),
  v.object({ status: v.literal("inProgress"), retryAfterSeconds: v.number() }),
  v.object({ status: v.literal("personNeeded"), reason: v.string(), url: v.string() }),
  v.object({ status: v.literal("refused"), reason: v.string() }),
);

export default action({
  args: { sessionToken: v.string(), kind: v.string(), instance: v.any() },
  returns: provisionResult,
  handler: (ctx, args) => provisionInstance(ctx, args),
});

const refused = (reason: string): ProvisionResult => ({ status: "refused", reason });

/**
 * Resolves the pipeline session, then the organization's implementation of `kind`, and calls its component's
 * standard call. Only a deploy job's pipeline session may provision.
 */
export async function provisionInstance(ctx: ActionCtx, input: {
  readonly sessionToken: string;
  readonly kind: string;
  readonly instance: unknown;
}): Promise<ProvisionResult> {
  const pipeline = await ctx.runQuery(internal.pipelineSessions.pipeline, { sessionToken: input.sessionToken });
  if (pipeline === null) {
    return await ctx.runQuery(internal.provision.isPersonSession, { sessionToken: input.sessionToken })
      ? refused("a person's session cannot provision; a deploy job signs in with `jive login --cicd`")
      : refused("the session token opens no live session; sign the deploy job in with `jive login --cicd`");
  }
  const resourceKind = resourceKindNamed(input.kind);
  if (resourceKind === undefined) {
    return refused(`"${input.kind}" is not a resource kind Jive knows; it knows ${RESOURCE_KINDS.map(({ kind }) => kind).join(", ")}`);
  }
  const configured = await ctx.runQuery(internal.provision.configuredImplementation, { organizationId: pipeline.organizationId, kind: input.kind });
  if (configured.implementation === null) {
    return refused(`the organization ${configured.organizationName} has no implementation configured for ${input.kind}`);
  }
  const implementation = resourceKind.implementations.find(({ packageName }) => packageName === configured.implementation);
  if (implementation === undefined) {
    return refused(`the organization ${configured.organizationName} configured ${configured.implementation} for ${input.kind}, which this server has not installed`);
  }
  const result = await implementation.ensureInstance(ctx, { instance: input.instance, pipeline, organizationName: configured.organizationName });
  console.log(`provision ${input.kind} ${JSON.stringify(input.instance)} for ${pipeline.repository.owner}/${pipeline.repository.name} (${pipeline.environment}): ${result.status}`);
  return result;
}

/** Whether the token opens a person's live session: told apart only to say why provisioning refuses it. */
export const isPersonSession = internalQuery({
  args: { sessionToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { sessionToken }) => await resolveSession(ctx.db, sessionToken) !== null,
});

/** The organization's name and its configured implementation of `kind`, or null for none. */
export const configuredImplementation = internalQuery({
  args: { organizationId: v.id("organizations"), kind: v.string() },
  returns: v.object({ organizationName: v.string(), implementation: v.union(v.null(), v.string()) }),
  handler: async (ctx, { organizationId, kind }) => {
    const organization = await ctx.db.get(organizationId);
    const configured = await ctx.db
      .query("resourceImplementations")
      .withIndex("by_organization_and_kind", (q) => q.eq("organizationId", organizationId).eq("kind", kind))
      .unique();
    return {
      organizationName: organization !== null ? organization.name : organizationId,
      implementation: configured !== null ? configured.implementation : null,
    };
  },
});
