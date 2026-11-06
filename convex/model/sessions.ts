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
 * How long a session lasts after its last use (Alex, 2026-11-06: "Let's do session length of a day and then the each
 * use you talked about extends the expiry to a day after that moment of use"): a day from sign-in, and every call that
 * acts with it moves its expiry to a day after that call (`resolveAndExtendSession`). No upper limit: a session used
 * at least once a day never ends.
 */
export const SESSION_MS = 24 * 60 * 60 * 1000;

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
 * deliberately indistinguishable to the caller. Every public function that acts for a person starts here or with
 * `resolveAndExtendSession`, so revoking a session stops it at once. A pipeline's token opens no person's session.
 */
export async function resolveSession(db: DatabaseReader, sessionToken: string): Promise<Doc<"sessions"> | null> {
  const tokenHash = await sha256Hex(sessionToken);
  const session = await db.query("sessions").withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
  if (session === null || session.revokedAt !== undefined || session.expiresAt <= Date.now()) return null;
  return session;
}

/**
 * `resolveSession` for a call that acts with the session, which is a use: its expiry moves to `SESSION_MS` after now.
 * Every mutation, and every action through one, that acts for a person starts here. A query cannot write, so a
 * query only checks the session (`resolveSession`) and leaves its expiry where it is.
 */
export async function resolveAndExtendSession(db: DatabaseWriter, sessionToken: string): Promise<Doc<"sessions"> | null> {
  const session = await resolveSession(db, sessionToken);
  if (session === null) return null;
  const expiresAt = Date.now() + SESSION_MS;
  await db.patch(session._id, { expiresAt });
  return { ...session, expiresAt };
}
