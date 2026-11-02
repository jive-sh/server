import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { usernameFor } from "./model/naming";
import { resourceKindNamed } from "./model/resourceKinds";

/**
 * Scaffolding until `organizations.create` and `codeRepositories.provision` exist (design doc §3, §12 step 3):
 * registers one organization and one GitHub repository by hand with `convex run seed:organizationWithRepository`.
 * Listed in skill-sync's `docs/lacking-durable-workflows.md`. Idempotent: an existing organization of that name,
 * and a repository already registered by the same ids, are reused.
 */
export const organizationWithRepository = internalMutation({
  args: {
    organizationName: v.string(),
    repository: v.object({ repositoryId: v.string(), repositoryOwnerId: v.string(), owner: v.string(), name: v.string() }),
  },
  returns: v.object({ organizationId: v.id("organizations"), codeRepositoryId: v.id("codeRepositories") }),
  handler: async (ctx, { organizationName, repository }) => {
    const existingOrganization = await ctx.db.query("organizations").withIndex("by_name", (q) => q.eq("name", organizationName)).unique();
    const organizationId = existingOrganization?._id ?? await ctx.db.insert("organizations", { name: organizationName });
    const existingRepository = await ctx.db
      .query("codeRepositories")
      .withIndex("by_github_ids", (q) => q.eq("repositoryId", repository.repositoryId).eq("repositoryOwnerId", repository.repositoryOwnerId))
      .unique();
    if (existingRepository !== null) {
      if (existingRepository.organizationId !== organizationId) {
        throw new Error(`${repository.owner}/${repository.name} is already registered to another organization`);
      }
      await ctx.db.patch(existingRepository._id, { owner: repository.owner, name: repository.name });
      return { organizationId, codeRepositoryId: existingRepository._id };
    }
    const codeRepositoryId = await ctx.db.insert("codeRepositories", { organizationId, ...repository });
    return { organizationId, codeRepositoryId };
  },
});

/**
 * One-off bootstrap, run once on production with `convex run seed:accountWithPasskey` (2026-11-01): the account for
 * a passkey that already exists with relying party `jive.sh`, copied from skill-sync-service's `credentials` table
 * (its credential id and COSE public key, neither secret), so its owner signs in to Jive with the passkey they
 * have. `webAuthnUserId` names the account (its handle is derived from it); skill-sync registered the passkey under
 * the user handle "owner", which signing in never reads. Idempotent: a passkey already imported is left alone.
 */
export const accountWithPasskey = internalMutation({
  args: { webAuthnUserId: v.string(), credentialId: v.string(), publicKey: v.string(), passkeyCreatedAt: v.number() },
  returns: v.object({ username: v.string(), created: v.boolean() }),
  handler: async (ctx, { webAuthnUserId, credentialId, publicKey, passkeyCreatedAt }) => {
    const existing = await ctx.db.query("passkeys").withIndex("by_credential_id", (q) => q.eq("credentialId", credentialId)).unique();
    if (existing !== null) {
      const account = await ctx.db.get(existing.accountId);
      return { username: account?.username ?? "", created: false };
    }
    const username = usernameFor(webAuthnUserId);
    if (await ctx.db.query("accounts").withIndex("by_username", (q) => q.eq("username", username)).first() !== null) {
      throw new Error(`the handle ${username} is taken; pass another webAuthnUserId`);
    }
    const accountId = await ctx.db.insert("accounts", { username, webAuthnUserId, createdAt: Date.now() });
    await ctx.db.insert("passkeys", { accountId, credentialId, publicKey, createdAt: passkeyCreatedAt });
    // Every account has its SSH key; a mutation cannot create one, so it is scheduled.
    await ctx.scheduler.runAfter(0, internal.ssh.ensureKey, { accountId, username });
    return { username, created: true };
  },
});

/**
 * Scaffolding until organizations configure resources themselves: sets the one implementation the organization uses
 * for a resource kind (`resourceImplementations`), with `convex run seed:resourceImplementation`. Refuses a kind or an
 * implementation this server hasn't installed. Idempotent: it replaces the organization's earlier choice for the kind.
 */
export const resourceImplementation = internalMutation({
  args: { organizationName: v.string(), kind: v.string(), implementation: v.string() },
  returns: v.null(),
  handler: async (ctx, { organizationName, kind, implementation }) => {
    const resourceKind = resourceKindNamed(kind);
    if (resourceKind === undefined) throw new Error(`"${kind}" is not a resource kind this server knows`);
    if (!resourceKind.implementations.some(({ packageName }) => packageName === implementation)) {
      throw new Error(`${implementation} is not an installed implementation of ${kind}`);
    }
    const organization = await ctx.db.query("organizations").withIndex("by_name", (q) => q.eq("name", organizationName)).unique();
    if (organization === null) throw new Error(`no organization is named ${organizationName}`);
    const existing = await ctx.db
      .query("resourceImplementations")
      .withIndex("by_organization_and_kind", (q) => q.eq("organizationId", organization._id).eq("kind", kind))
      .unique();
    if (existing !== null) await ctx.db.patch(existing._id, { implementation });
    else await ctx.db.insert("resourceImplementations", { organizationId: organization._id, kind, implementation });
    return null;
  },
});
