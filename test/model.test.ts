import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, Option, pipe } from "effect";
import { authorizePipelineCaller, type PipelineCaller } from "../convex/model/pipelineCaller";
import { PENDING_PUBLISHER_WINDOW_MS, planPublisher, type ListedPublisher, type PublisherClaims } from "../convex/model/publisherPlan";
import {
  ProvisioningRecords,
  RegistryConnector,
  provisionPackage,
  type IProvisioningRecords,
  type IRegistryConnector,
  type NpmAccount,
  type PackageRecord,
} from "../convex/model/provisioning";
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
    expect(await refusal({ ...deployJobIdentity, event_name: "pull_request" })).toContain("a pull_request run may not provision");
  });

  test("refuses a workflow other than pipeline.yml", async () => {
    expect(await refusal({ ...deployJobIdentity, workflow_ref: "chaine-dance/jive-test-package/.github/workflows/release.yml@refs/heads/main" }))
      .toContain("only .github/workflows/pipeline.yml may provision");
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

const wanted: PublisherClaims = {
  provider: "github",
  repository: { owner: "chaine-dance", name: "jive-test-package" },
  workflowFile: "pipeline.yml",
  environment: "latest",
};
const NOW = 1_800_000_000_000;

describe("planPublisher", () => {
  test("registers when no publisher matches", () => {
    const other: ListedPublisher = { id: "p1", claims: { ...wanted, environment: "next" }, status: "validated" };
    expect(planPublisher({ listed: [other], wanted, maybeRegisteredAt: Option.none(), now: NOW })).toEqual({ action: "register", removeIds: [] });
  });

  test("keeps a validated publisher, matching owner and name case-insensitively", () => {
    const listed: ListedPublisher = { id: "p1", claims: { ...wanted, repository: { owner: "Chaine-Dance", name: "Jive-Test-Package" } }, status: "validated" };
    expect(planPublisher({ listed: [listed], wanted, maybeRegisteredAt: Option.none(), now: NOW })).toEqual({ action: "keep" });
  });

  test("keeps an unvalidated publisher Jive registered inside the window", () => {
    const listed: ListedPublisher = { id: "p1", claims: wanted, status: "unvalidated" };
    const registeredAt = NOW - PENDING_PUBLISHER_WINDOW_MS + 1;
    expect(planPublisher({ listed: [listed], wanted, maybeRegisteredAt: Option.some(registeredAt), now: NOW })).toEqual({ action: "keep" });
  });

  test("replaces an unvalidated publisher registered too long ago, which npm may have expired", () => {
    const listed: ListedPublisher = { id: "p1", claims: wanted, status: "unvalidated" };
    const registeredAt = NOW - PENDING_PUBLISHER_WINDOW_MS;
    expect(planPublisher({ listed: [listed], wanted, maybeRegisteredAt: Option.some(registeredAt), now: NOW }))
      .toEqual({ action: "register", removeIds: ["p1"] });
  });

  test("replaces an unvalidated publisher Jive has no record of registering", () => {
    const listed: ListedPublisher = { id: "p1", claims: wanted, status: "unvalidated" };
    expect(planPublisher({ listed: [listed], wanted, maybeRegisteredAt: Option.none(), now: NOW })).toEqual({ action: "register", removeIds: ["p1"] });
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

const caller: PipelineCaller = {
  repositoryId: "111",
  repositoryOwnerId: "222",
  repository: { owner: "chaine-dance", name: "jive-test-package" },
  environment: "latest",
  workflowFile: "pipeline.yml",
};
const account: NpmAccount = { token: "npm-token", secondFactor: { type: "totp", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" } };
const PACKAGE = "@chaine.dance/jive-test-package";

/** In-memory records and connector, logging every call in order. */
function fakes(input: {
  registered?: boolean;
  maybePackage?: Option.Option<PackageRecord>;
  connected?: boolean;
  claimHeld?: boolean;
  placeholder?: "created" | "alreadyExists" | "maintainedByAnotherAccount";
  listed?: ReadonlyArray<ListedPublisher>;
}) {
  const calls: Array<string> = [];
  const records: IProvisioningRecords = {
    findCodeRepository: () => Effect.succeed(input.registered === false ? Option.none() : Option.some({ id: "repo-1", organizationId: "org-1" })),
    findPackage: () => Effect.succeed(input.maybePackage ?? Option.none()),
    npmAccount: () => Effect.succeed(input.connected === false ? Option.none() : Option.some(account)),
    claim: () => Effect.sync(() => {
      calls.push("claim");
      return input.claimHeld === true ? Option.none() : Option.some("holder-1");
    }),
    release: ({ holder }) => Effect.sync(() => void calls.push(`release ${holder}`)),
    recordProvisioned: ({ registeredPublisherFor }) => Effect.sync(() => void calls.push(`record ${Option.getOrElse(registeredPublisherFor, () => "-")}`)),
  };
  const connector: IRegistryConnector = {
    createPlaceholder: () => Effect.sync(() => {
      calls.push("createPlaceholder");
      return input.placeholder === "created" ? { status: "created", version: "0.0.0" } as const : { status: input.placeholder ?? "alreadyExists" } as const;
    }),
    listTrustedPublishers: () => Effect.sync(() => {
      calls.push("listTrustedPublishers");
      return input.listed ?? [];
    }),
    registerTrustedPublisher: ({ publisher }) => Effect.sync(() => void calls.push(`register ${publisher.environment}`)),
    removeTrustedPublisher: ({ id }) => Effect.sync(() => void calls.push(`remove ${id}`)),
  };
  const layer = Layer.mergeAll(Layer.succeed(ProvisioningRecords, records), Layer.succeed(RegistryConnector, connector));
  const run = () => Effect.runPromiseExit(pipe(provisionPackage({ caller, packageName: PACKAGE, now: NOW }), Effect.provide(layer)));
  return { calls, run };
}

describe("provisionPackage", () => {
  test("a new package: placeholder, publisher for the job's environment, recorded, claim released", async () => {
    const { calls, run } = fakes({ placeholder: "created" });
    expect(await run()).toEqual(Exit.succeed({ status: "ready" }));
    expect(calls).toEqual(["claim", "createPlaceholder", "listTrustedPublishers", "register latest", "record latest", "release holder-1"]);
  });

  test("an already provisioned package with a validated publisher changes nothing on npm", async () => {
    const { calls, run } = fakes({
      maybePackage: Option.some({ codeRepositoryId: "repo-1", trustedPublishers: [{ environment: "latest", registeredAt: NOW - 1000 }] }),
      listed: [{ id: "p1", claims: { provider: "github", repository: caller.repository, workflowFile: "pipeline.yml", environment: "latest" }, status: "validated" }],
    });
    expect(await run()).toEqual(Exit.succeed({ status: "ready" }));
    expect(calls).toEqual(["claim", "createPlaceholder", "listTrustedPublishers", "record -", "release holder-1"]);
  });

  test("an expired publisher is removed and registered again", async () => {
    const { calls, run } = fakes({
      maybePackage: Option.some({ codeRepositoryId: "repo-1", trustedPublishers: [{ environment: "latest", registeredAt: NOW - 3 * 24 * 60 * 60 * 1000 }] }),
      listed: [{ id: "p1", claims: { provider: "github", repository: caller.repository, workflowFile: "pipeline.yml", environment: "latest" }, status: "unvalidated" }],
    });
    expect(await run()).toEqual(Exit.succeed({ status: "ready" }));
    expect(calls).toEqual(["claim", "createPlaceholder", "listTrustedPublishers", "remove p1", "register latest", "record latest", "release holder-1"]);
  });

  test("another job's claim answers inProgress without touching npm", async () => {
    const { calls, run } = fakes({ claimHeld: true });
    expect(await run()).toEqual(Exit.succeed({ status: "inProgress" }));
    expect(calls).toEqual(["claim"]);
  });

  async function refusedReason(exit: Exit.Exit<unknown, unknown>): Promise<string> {
    expect(Exit.isFailure(exit)).toBe(true);
    return JSON.stringify(exit);
  }

  test("refuses an unregistered repository before claiming", async () => {
    const { calls, run } = fakes({ registered: false });
    expect(await refusedReason(await run())).toContain("is not a code repository registered with Jive");
    expect(calls).toEqual([]);
  });

  test("refuses a package bound to another repository", async () => {
    const { calls, run } = fakes({ maybePackage: Option.some({ codeRepositoryId: "repo-2", trustedPublishers: [] }) });
    expect(await refusedReason(await run())).toContain("is provisioned for another code repository");
    expect(calls).toEqual([]);
  });

  test("refuses when the organization has no npm connection, releasing the claim", async () => {
    const { calls, run } = fakes({ connected: false });
    expect(await refusedReason(await run())).toContain("has not connected an npm account");
    expect(calls).toEqual(["claim", "release holder-1"]);
  });

  test("refuses a package another npm account maintains, registering nothing", async () => {
    const { calls, run } = fakes({ placeholder: "maintainedByAnotherAccount" });
    expect(await refusedReason(await run())).toContain("does not maintain it");
    expect(calls).toEqual(["claim", "createPlaceholder", "release holder-1"]);
  });
});
