import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

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
