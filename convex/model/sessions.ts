import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { sha256Hex } from "./tokens";

/**
 * A person's session (Alex, 2026-11-01: "a session should only be obtainable via human passkey, cicd oidc token
 * exchange, or jive mints a token and hands it off to a compute provider running an agent workflow"). This module
 * holds the first way; `pipelineSessions.ts` the second; the third waits on the compute resource kind.
 * `insertAccountSession` is the only code that writes a person's session, and a test holds every other file to that.
 */

/**
 * How long a session lasts, whether a browser opened it or a program claimed it: a working day, short enough
 * that a token left in shell history or on a disk is not a lasting credential.
 */
export const SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * Opens a person's session. Callers reach it only after a passkey ceremony verified the person: directly in the
 * browser (`browser`), or through a sign-in request that ceremony approved (`signInRequest`).
 */
export async function insertAccountSession(db: DatabaseWriter, input: {
  readonly accountId: Id<"accounts">;
  readonly tokenHash: string;
  readonly origin: Doc<"sessions">["origin"];
}): Promise<{ readonly expiresAt: number }> {
  const now = Date.now();
  const expiresAt = now + SESSION_MS;
  await db.insert("sessions", { accountId: input.accountId, tokenHash: input.tokenHash, origin: input.origin, createdAt: now, expiresAt });
  return { expiresAt };
}

/**
 * The live session a presented token opens, or null when it is unknown, expired or revoked; the three are
 * deliberately indistinguishable to the caller. Every public function that acts for a person starts here, so
 * revoking a session stops it at once. A pipeline's token opens no person's session.
 */
export async function resolveSession(db: DatabaseReader, sessionToken: string): Promise<Doc<"sessions"> | null> {
  const tokenHash = await sha256Hex(sessionToken);
  const session = await db.query("sessions").withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
  if (session === null || session.revokedAt !== undefined || session.expiresAt <= Date.now()) return null;
  return session;
}
