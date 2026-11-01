import type { Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import type { PipelineCaller } from "./pipelineCaller";
import { sha256Hex } from "./tokens";

/**
 * A code repository's pipeline session: the second way to a session (`sessions.ts`), a GitHub Actions ID token
 * exchanged by `pipelineSessions:signIn`. `insertPipelineSession` is the only code that writes one, and a test holds
 * every other file to that.
 */

/**
 * How long a pipeline session lasts: longer than a deploy job's calls take (provisioning waits up to 10 minutes for
 * another job), short enough that a token printed in a job's log is soon worthless. A job that needs Jive later
 * signs in again; it can ask GitHub for a fresh ID token at any point.
 */
export const PIPELINE_SESSION_MS = 60 * 60 * 1000;

/** What a pipeline session acts as: its registered code repository, and the job's claims checked at sign-in. */
export interface PipelineSession {
  readonly codeRepositoryId: Id<"codeRepositories">;
  readonly organizationId: Id<"organizations">;
  /** The repository's owner and name when the job signed in, which npm's trusted publisher names. */
  readonly repository: { readonly owner: string; readonly name: string };
  /** The GitHub Actions environment the job runs in. */
  readonly environment: string;
  /** The calling workflow's file name, `pipeline.yml`. */
  readonly workflowFile: string;
}

/**
 * Opens a session for the job's code repository, found by GitHub's immutable ids, never names. Null when no code
 * repository is registered by those ids. Callers reach it only with claims `authorizePipelineCaller` accepted.
 */
export async function insertPipelineSession(db: DatabaseWriter, input: {
  readonly caller: PipelineCaller;
  readonly tokenHash: string;
}): Promise<{ readonly sessionId: Id<"pipelineSessions">; readonly expiresAt: number } | null> {
  const { caller } = input;
  const repository = await db
    .query("codeRepositories")
    .withIndex("by_github_ids", (q) => q.eq("repositoryId", caller.repositoryId).eq("repositoryOwnerId", caller.repositoryOwnerId))
    .unique();
  if (repository === null) return null;
  const now = Date.now();
  const expiresAt = now + PIPELINE_SESSION_MS;
  const sessionId = await db.insert("pipelineSessions", {
    codeRepositoryId: repository._id,
    tokenHash: input.tokenHash,
    repository: caller.repository,
    environment: caller.environment,
    workflowFile: caller.workflowFile,
    createdAt: now,
    expiresAt,
  });
  return { sessionId, expiresAt };
}

/**
 * The live pipeline session a presented token opens, or null when it is unknown or expired, or its code repository
 * was removed since. A person's token opens no pipeline session.
 */
export async function resolvePipelineSession(db: DatabaseReader, sessionToken: string): Promise<PipelineSession | null> {
  const tokenHash = await sha256Hex(sessionToken);
  const session = await db.query("pipelineSessions").withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
  if (session === null || session.expiresAt <= Date.now()) return null;
  const repository = await db.get(session.codeRepositoryId);
  if (repository === null) return null;
  return {
    codeRepositoryId: repository._id,
    organizationId: repository.organizationId,
    repository: session.repository,
    environment: session.environment,
    workflowFile: session.workflowFile,
  };
}
