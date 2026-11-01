import { describe, expect, test } from "bun:test";
import { Effect, Exit, pipe } from "effect";
import { authorizePipelineCaller } from "../convex/model/pipelineCaller";
import { open, parseConnectionKey, seal } from "../convex/model/sealing";

/** The claims GitHub puts in a deploy job's ID token, as Convex hands them to a function. */
const deployJobIdentity = {
  issuer: "https://token.actions.githubusercontent.com",
  subject: "repo:chaine-dance/jive-test-package:environment:latest",
  tokenIdentifier: "https://token.actions.githubusercontent.com|repo:chaine-dance/jive-test-package:environment:latest",
  repository_id: "111",
  repository_owner_id: "222",
  repository: "chaine-dance/jive-test-package",
  workflow_ref: "chaine-dance/jive-test-package/.github/workflows/pipeline.yml@refs/heads/main",
  job_workflow_ref: "jive-sh/jive/.github/workflows/reusable-pipeline.yml@refs/heads/main",
  event_name: "push",
  ref: "refs/heads/main",
  ref_protected: "true",
  runner_environment: "github-hosted",
  environment: "latest",
};

function refusal(identity: unknown): Promise<string> {
  return Effect.runPromise(pipe(
    authorizePipelineCaller(identity),
    Effect.flip,
    Effect.map((refused) => refused.reason),
  ));
}

describe("authorizePipelineCaller", () => {
  test("reads a deploy job of pipeline.yml on a protected branch", async () => {
    expect(await Effect.runPromise(authorizePipelineCaller(deployJobIdentity))).toEqual({
      repositoryId: "111",
      repositoryOwnerId: "222",
      repository: { owner: "chaine-dance", name: "jive-test-package" },
      environment: "latest",
      workflowFile: "pipeline.yml",
    });
    expect(await Effect.runPromise(authorizePipelineCaller({ ...deployJobIdentity, ref_protected: true }))).toMatchObject({ environment: "latest" });
  });

  test("refuses a job with no environment", async () => {
    const { environment: _environment, ...identity } = deployJobIdentity;
    expect(await refusal(identity)).toContain("runs in no GitHub Actions environment");
  });

  test("refuses an unprotected ref", async () => {
    expect(await refusal({ ...deployJobIdentity, ref_protected: "false" })).toContain("unprotected branch");
  });

  test("refuses a pull request", async () => {
    expect(await refusal({ ...deployJobIdentity, event_name: "pull_request" })).toContain("a pull_request run may not sign in");
  });

  test("refuses a workflow other than pipeline.yml", async () => {
    expect(await refusal({ ...deployJobIdentity, workflow_ref: "chaine-dance/jive-test-package/.github/workflows/release.yml@refs/heads/main" }))
      .toContain("only .github/workflows/pipeline.yml may sign in");
  });

  test("refuses a self-hosted runner", async () => {
    expect(await refusal({ ...deployJobIdentity, runner_environment: "self-hosted" })).toContain("self-hosted runner");
  });

  test("refuses a token from another issuer, or without GitHub's claims", async () => {
    expect(await refusal({ ...deployJobIdentity, issuer: "https://accounts.example.com" })).toContain("not a GitHub Actions job");
    const { repository_id: _repositoryId, ...identity } = deployJobIdentity;
    expect(await refusal(identity)).toContain("not a GitHub Actions job");
  });
});

describe("sealing", () => {
  const CONNECTION_KEY = `1:${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;

  test("opens what it sealed, with a fresh nonce each time", async () => {
    const key = await Effect.runPromise(parseConnectionKey(CONNECTION_KEY));
    const first = await Effect.runPromise(seal(key, "the credential"));
    const second = await Effect.runPromise(seal(key, "the credential"));
    expect(first).not.toBe(second);
    expect(first).not.toContain("credential");
    expect(await Effect.runPromise(open(key, first))).toBe("the credential");
  });

  test("refuses to open under another key, or a tampered value", async () => {
    const key = await Effect.runPromise(parseConnectionKey(CONNECTION_KEY));
    const otherKey = await Effect.runPromise(parseConnectionKey(`1:${btoa(String.fromCharCode(...new Uint8Array(32).fill(8)))}`));
    const sealed = await Effect.runPromise(seal(key, "the credential"));
    expect(Exit.isFailure(await Effect.runPromiseExit(open(otherKey, sealed)))).toBe(true);
    const [nonce, ciphertext] = sealed.split(".");
    const tampered = `${nonce}.${ciphertext!.slice(0, -2)}${ciphertext!.endsWith("A") ? "B" : "A"}${ciphertext!.slice(-1)}`;
    expect(Exit.isFailure(await Effect.runPromiseExit(open(key, tampered)))).toBe(true);
  });

  test("refuses a malformed CONNECTION_KEY without echoing it", async () => {
    for (const value of [undefined, "nokey", "0:AAAA", `1:${btoa("short")}`]) {
      const exit = await Effect.runPromiseExit(parseConnectionKey(value));
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });
});
