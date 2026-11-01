import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { resolveSession } from "./model/sessions";

/** Revokes the presented session; it stops working for every call at once. Signing out twice is not an error. */
export const signOut = mutation({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionToken }) => {
    const session = await resolveSession(ctx.db, sessionToken);
    if (session !== null) await ctx.db.patch(session._id, { revokedAt: Date.now() });
    return null;
  },
});
