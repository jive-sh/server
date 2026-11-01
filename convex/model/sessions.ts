import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { sha256Hex } from "./tokens";

/**
 * How long a session lasts, whether a browser opened it or a program claimed it: a working day, short enough
 * that a token left in shell history or on a disk is not a lasting credential.
 */
export const SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * The live session a presented token opens, or null when it is unknown, expired or revoked; the three are
 * deliberately indistinguishable to the caller. Every public function that acts for a person starts here, so
 * revoking a session stops it at once.
 */
export async function resolveSession(db: DatabaseReader, sessionToken: string): Promise<Doc<"sessions"> | null> {
  const tokenHash = await sha256Hex(sessionToken);
  const session = await db.query("sessions").withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
  if (session === null || session.revokedAt !== undefined || session.expiresAt <= Date.now()) return null;
  return session;
}
