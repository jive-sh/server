import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { resolve } from "node:path";

/**
 * Alex (2026-11-01): "a session should only be obtainable via human passkey, cicd oidc token exchange, or jive mints
 * a token and hands it off to a compute provider running an agent workflow". Each session table has one function
 * that writes it, reached only after its check: `insertAccountSession` after a passkey ceremony, and
 * `insertPipelineSession` after a GitHub Actions ID token is verified. This holds every other file in `convex/` to
 * that, so a new way to open a session fails this test until it goes through one of them.
 */

const CONVEX_DIR = resolve(import.meta.dir, "../convex");

/** The one file allowed to write each session table. */
const WRITERS: Readonly<Record<string, string>> = {
  sessions: "model/sessions.ts",
  pipelineSessions: "model/pipelineSessions.ts",
};

/** The only write that creates a row, `db.insert`, names its table; `patch` and `replace` change existing rows. */
const SESSION_INSERT = /\.insert\(\s*["'`](sessions|pipelineSessions)["'`]/g;

describe("opening a session", () => {
  test("only the two session modules insert sessions", async () => {
    const inserts: Array<string> = [];
    for await (const file of new Glob("**/*.ts").scan(CONVEX_DIR)) {
      if (file.startsWith("_generated/")) continue;
      const source = await Bun.file(resolve(CONVEX_DIR, file)).text();
      for (const match of source.matchAll(SESSION_INSERT)) inserts.push(`${match[1]} in ${file}`);
    }
    expect(inserts.sort()).toEqual(Object.entries(WRITERS).map(([table, file]) => `${table} in ${file}`).sort());
  });

  test("each session module's insert is reached only from its check", async () => {
    const callers: Array<string> = [];
    for await (const file of new Glob("**/*.ts").scan(CONVEX_DIR)) {
      if (file.startsWith("_generated/")) continue;
      const source = await Bun.file(resolve(CONVEX_DIR, file)).text();
      for (const writer of ["insertAccountSession", "insertPipelineSession"]) {
        if (new RegExp(`\\b${writer}\\(`).test(source) && !Object.values(WRITERS).includes(file)) callers.push(`${writer} in ${file}`);
      }
    }
    // auth.ts after a passkey registration or sign-in; signInRequests.ts when a program claims a request a passkey
    // ceremony approved; pipelineSessions.ts after Convex verified the ID token and `authorizePipelineCaller` its claims.
    expect(callers.sort()).toEqual([
      "insertAccountSession in auth.ts",
      "insertAccountSession in signInRequests.ts",
      "insertPipelineSession in pipelineSessions.ts",
    ]);
  });
});
