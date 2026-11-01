import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** How long a program's sign-in request can be approved and claimed. */
export const SIGN_IN_REQUEST_MS = 10 * 60 * 1000;

export const UNUSABLE_SIGN_IN_REQUEST = "This sign-in request has expired or was already used. Start again from the program that opened it.";

/**
 * Approves a pending request for the account that just proved a passkey, inside the same transaction that opens
 * the person's session, so a failed approval leaves no session behind.
 */
export async function approveSignInRequest(ctx: MutationCtx, input: { readonly requestId: string; readonly accountId: Id<"accounts"> }): Promise<void> {
  const id = ctx.db.normalizeId("signInRequests", input.requestId);
  const request = id === null ? null : await ctx.db.get(id);
  if (request === null || request.approvedAccountId !== undefined || request.claimedAt !== undefined || request.expiresAt <= Date.now()) {
    throw new ConvexError(UNUSABLE_SIGN_IN_REQUEST);
  }
  await ctx.db.patch(request._id, { approvedAccountId: input.accountId });
}
