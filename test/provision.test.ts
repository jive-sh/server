import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LOCAL_ENV, SERVER_DIR, TIMEOUT, convex, initLocalDeployment, startDevServer, type DevServer } from "./support/localBackend";

/**
 * `packages:provision` end to end, inside Convex's runtime: this package pushed to an anonymous local Convex
 * backend (no Convex account), called over Convex's HTTP API with RS256 tokens shaped like GitHub Actions ID
 * tokens and signed by a key this test generates, whose JWKS the deployment trusts in place of GitHub's
 * (`GITHUB_ACTIONS_JWKS`). The npm connector acts on a fake registry served here, which guards every write with
 * npm's web second-factor challenge, as npm does. Nothing here reaches npm or GitHub.
 */

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "https://api.jive.sh";
const PACKAGE = "@chaine.dance/jive-test-package";
const NPM_TOKEN = "npm-test-token";
const CONNECTION_KEY = `1:${btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))}`;
const REPOSITORY = { repositoryId: "900001", repositoryOwnerId: "900002", owner: "chaine-dance", name: "jive-test-package" };

function base64Url(bytes: Uint8Array | string): string {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return buffer.toString("base64url");
}

/** The page npm names when it wants a person to answer its second factor, as the fake registry names it. */
const SECOND_FACTOR_PAGE = "https://www.npmjs.com/auth/cli/approve-1";

const npm = {
  packages: new Map<string, { maintainers: Array<string>; publishedBy: Array<string> }>(),
  publishes: [] as Array<string>,
  trust: [] as Array<{ id: string; type: string; claims: any }>,
  trustRequests: 0,
  oneTimePasswords: [] as Array<string>,
};

let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let registry: ReturnType<typeof Bun.serve>;
let devServer: DevServer | undefined;
let convexUrl: string;

async function idToken(claims: Record<string, unknown>, key = signingKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: "test-key" };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: `repo:${REPOSITORY.owner}/${REPOSITORY.name}:environment:latest`,
    iat: now,
    nbf: now,
    exp: now + 300,
    repository_id: REPOSITORY.repositoryId,
    repository_owner_id: REPOSITORY.repositoryOwnerId,
    repository: `${REPOSITORY.owner}/${REPOSITORY.name}`,
    workflow_ref: `${REPOSITORY.owner}/${REPOSITORY.name}/.github/workflows/pipeline.yml@refs/heads/main`,
    job_workflow_ref: "jive-sh/jive/.github/workflows/reusable-pipeline.yml@refs/heads/main",
    event_name: "push",
    ref: "refs/heads/main",
    ref_protected: "true",
    runner_environment: "github-hosted",
    environment: "latest",
    ...claims,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64Url(signature)}`;
}

/** Calls `packages:provision` as jive-abstract-library does: Convex's HTTP API with the ID token as bearer. */
async function provision(token: string | undefined): Promise<any> {
  const response = await fetch(`${convexUrl}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ path: "packages:provision", args: { registry: "npm", packageName: PACKAGE }, format: "json" }),
  });
  return { httpStatus: response.status, body: await response.json().catch(() => null) };
}

beforeAll(async () => {
  const generate = () => crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pair = await generate();
  signingKey = pair.privateKey;
  otherSigningKey = (await generate()).privateKey;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwks = JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] });

  registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorized = request.headers.get("authorization") === `Bearer ${NPM_TOKEN}`;
      const otp = request.headers.get("npm-otp");
      if (otp !== null) npm.oneTimePasswords.push(otp);
      // npm's answer to a write sent with `npm-auth-type: web` and no one-time password: its page for a person.
      const challenge = () => Response.json(
        { authUrl: SECOND_FACTOR_PAGE, doneUrl: "https://registry.npmjs.org/-/v1/done?authId=1" },
        { status: 401, headers: { "www-authenticate": "OTP" } },
      );
      if (url.pathname === "/-/whoami") return authorized ? Response.json({ username: "jive-test-account" }) : new Response("no", { status: 401 });
      const trust = url.pathname.match(/^\/-\/package\/([^/]+)\/trust(?:\/([^/]+))?$/);
      if (trust !== null) {
        if (!authorized) return new Response("no", { status: 401 });
        if (request.method === "GET") return Response.json(npm.trust);
        if (otp === null) return challenge();
        if (request.method === "DELETE") {
          npm.trust = npm.trust.filter((config) => config.id !== decodeURIComponent(trust[2]!));
          return new Response(null, { status: 204 });
        }
        npm.trustRequests += 1;
        const [config] = (await request.json()) as Array<any>;
        npm.trust.push({ id: `trust-${npm.trustRequests}`, type: config.type, claims: config.claims });
        return Response.json([config]);
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      if (request.method === "GET") {
        const record = npm.packages.get(name);
        if (record === undefined) return Response.json({ error: "Not found" }, { status: 404 });
        const versions = Object.fromEntries(record.publishedBy.map((oidcConfigId, index) => [
          `0.0.${index + 1}`,
          { _npmUser: { name: "GitHub Actions", trustedPublisher: { oidcConfigId } } },
        ]));
        return Response.json({ name, maintainers: record.maintainers.map((maintainer) => ({ name: maintainer })), versions });
      }
      if (request.method === "PUT") {
        if (!authorized) return new Response("no", { status: 401 });
        if (otp === null) return challenge();
        npm.publishes.push(name);
        npm.packages.set(name, { maintainers: ["jive-test-account"], publishedBy: [] });
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  await initLocalDeployment();
  await convex(["env", "set", "GITHUB_ACTIONS_JWKS", `data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString("base64")}`]);
  await convex(["env", "set", "CONNECTION_KEY", CONNECTION_KEY]);
  await convex(["env", "set", "NPM_REGISTRY_URL", `http://127.0.0.1:${registry.port}`]);

  devServer = await startDevServer();
  convexUrl = devServer.url;

  const seeded = JSON.parse(await convex(["run", "seed:organizationWithRepository", JSON.stringify({ organizationName: "jive-test", repository: REPOSITORY })]));
  expect(seeded.organizationId).toBeString();

  // Connected the way a person does: `bun run connect-npm`, its hidden answer piped in, checking the token
  // against the fake registry's /-/whoami.
  const connect = Bun.spawn(["bun", "run", "connect-npm", "--", "--organization", "jive-test", "--npm-registry", `http://127.0.0.1:${registry.port}`], {
    cwd: SERVER_DIR, env: LOCAL_ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  connect.stdin.write(`${NPM_TOKEN}\n`);
  connect.stdin.end();
  const [connectOut, connectErr, connectExit] = await Promise.all([new Response(connect.stdout).text(), new Response(connect.stderr).text(), connect.exited]);
  expect(connectExit, connectErr).toBe(0);
  expect(`${connectOut}${connectErr}`).toContain("The token belongs to npm user jive-test-account");
  expect(`${connectOut}${connectErr}`).not.toContain(NPM_TOKEN);
  expect(npm.oneTimePasswords).toEqual([]);
}, TIMEOUT);

afterAll(async () => {
  await devServer?.stop();
  registry?.stop(true);
});

describe("who may call", () => {
  test("a call without a token is refused", async () => {
    expect(await provision(undefined)).toMatchObject({ body: { status: "success", value: { status: "refused", reason: expect.stringContaining("no GitHub Actions ID token") } } });
  }, TIMEOUT);

  test("a token for another audience, or signed by a key the deployment does not trust, is rejected by Convex", async () => {
    for (const token of [await idToken({ aud: "https://example.com" }), await idToken({}, otherSigningKey)]) {
      const { body } = await provision(token);
      expect(body?.status === "success").toBe(false);
    }
  }, TIMEOUT);

  test("a job of a repository nobody registered is refused", async () => {
    expect(await provision(await idToken({ repository_id: "1" })))
      .toMatchObject({ body: { value: { status: "refused", reason: expect.stringContaining("is not a code repository registered with Jive") } } });
  }, TIMEOUT);

  test("a pull request's job is refused", async () => {
    expect(await provision(await idToken({ event_name: "pull_request" })))
      .toMatchObject({ body: { value: { status: "refused", reason: expect.stringContaining("pull_request") } } });
  }, TIMEOUT);
});

describe("provisioning", () => {
  test("a new package is refused with npm's second-factor page, publishing nothing, since nothing passes a person's answer back yet", async () => {
    expect(await provision(await idToken({}))).toMatchObject({ body: { status: "success", value: {
      status: "refused",
      reason: `npm asked for its second factor to publish ${PACKAGE}'s placeholder; a person answers it on ${SECOND_FACTOR_PAGE}, and Jive cannot pass that answer back to npm yet`,
    } } });
    expect(npm.publishes).toEqual([]);
    expect(npm.oneTimePasswords).toEqual([]);
  }, TIMEOUT);

  test("a package the account maintains, whose publisher for pipeline.yml and the environment has published, is ready with no write to npm", async () => {
    npm.packages.set(PACKAGE, { maintainers: ["jive-test-account"], publishedBy: ["trust-1"] });
    npm.trust = [{
      id: "trust-1",
      type: "github",
      claims: { repository: "chaine-dance/jive-test-package", workflow_ref: { file: "pipeline.yml" }, environment: "latest" },
    }];
    expect(await provision(await idToken({}))).toMatchObject({ body: { status: "success", value: { status: "ready" } } });
    expect(await provision(await idToken({}))).toMatchObject({ body: { value: { status: "ready" } } });
    expect(npm.publishes).toEqual([]);
    expect(npm.trustRequests).toBe(0);
    expect(npm.oneTimePasswords).toEqual([]);
  }, TIMEOUT);

  test("another deploy job's claim answers inProgress, and the package provisions once it is released", async () => {
    await convex(["run", "packages:claim", JSON.stringify({ packageName: PACKAGE, holder: "another-job" })]);
    expect(await provision(await idToken({}))).toMatchObject({ body: { value: { status: "inProgress" } } });
    await convex(["run", "packages:release", JSON.stringify({ packageName: PACKAGE, holder: "another-job" })]);
    expect(await provision(await idToken({}))).toMatchObject({ body: { value: { status: "ready" } } });
  }, TIMEOUT);

  test("another repository asking for the same package name is refused", async () => {
    await convex(["run", "seed:organizationWithRepository", JSON.stringify({
      organizationName: "jive-test",
      repository: { repositoryId: "900003", repositoryOwnerId: REPOSITORY.repositoryOwnerId, owner: "chaine-dance", name: "impostor" },
    })]);
    expect(await provision(await idToken({ repository_id: "900003", repository: "chaine-dance/impostor" })))
      .toMatchObject({ body: { value: { status: "refused", reason: expect.stringContaining("provisioned for another code repository") } } });
  }, TIMEOUT);

  test("a connection request is spent by its first use", async () => {
    const { requestId } = JSON.parse(await convex(["run", "connections:openNpmConnectionRequest", JSON.stringify({ organizationName: "jive-test" })]));
    const complete = () => fetch(`${convexUrl}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "connections:completeNpmConnection", args: { requestId, token: NPM_TOKEN }, format: "json" }),
    }).then((response) => response.json());
    expect(await complete()).toMatchObject({ status: "success" });
    expect(await complete()).toMatchObject({ status: "error", errorMessage: expect.stringContaining("unknown, already used or expired") });
  }, TIMEOUT);

  test("the npm token is stored sealed, never in the clear", async () => {
    const stored = await convex(["run", "--inline-query", `return await ctx.db.query("connections").collect()`]);
    expect(stored).toContain("sealedCredential");
    expect(stored).not.toContain(NPM_TOKEN);
  }, TIMEOUT);
});
