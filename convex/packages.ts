import { v } from "convex/values";
import { action } from "./_generated/server";
import { provisionInstance } from "./provision";

/**
 * `packages:provision`, the call jive-abstract-library 0.8.0's deploy makes right before it publishes. It goes away
 * once callers move to `provision` through the `jive` CLI (`jive login --cicd`, then `jive provision`); until then
 * it is `provision` for kind `connector-package-registry`, answered in its older shape, which has no
 * `personNeeded`: that becomes `refused`, naming the page.
 */
export const provision = action({
  args: { sessionToken: v.string(), registry: v.literal("npm"), packageName: v.string() },
  returns: v.union(
    v.object({ status: v.literal("ready") }),
    v.object({ status: v.literal("inProgress") }),
    v.object({ status: v.literal("refused"), reason: v.string() }),
  ),
  handler: async (ctx, { sessionToken, packageName }) => {
    const result = await provisionInstance(ctx, { sessionToken, kind: "connector-package-registry", instance: { packageName } });
    switch (result.status) {
      case "ready":
        return { status: "ready" } as const;
      case "inProgress":
        return { status: "inProgress" } as const;
      case "personNeeded":
        return { status: "refused", reason: `${result.reason}: ${result.url}` } as const;
      case "refused":
        return { status: "refused", reason: result.reason } as const;
    }
  },
});
