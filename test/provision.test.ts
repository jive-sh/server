import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { registerAccount } from "./support/accounts";
import { createSoftwarePasskey } from "./support/softwareAuthenticator";
import { LOCAL_ENV, SERVER_DIR, TEST_CONNECTION_KEY, TIMEOUT, convex, generateGithubActionsJwks, run, initLocalDeployment, startDevServer, type DevServer } from "./support/localBackend";

/**
 * A pipeline signing in (`pipelineSessions:signIn`) and `packages:provision` end to end, inside Convex's runtime:
 * this package pushed to an anonymous local Convex backend (no Convex account), called over Convex's HTTP API as
 * jive-abstract-library calls it, with RS256 tokens shaped like GitHub Actions ID tokens and signed by a key this test
 * generates, whose JWKS the deployment trusts in place of GitHub's
 * (`GITHUB_ACTIONS_JWKS`). The npm connector acts on a fake registry served here, which guards every write with
 * npm's web second-factor challenge, as npm does. Nothing here reaches npm or GitHub.
 */

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "https://api.jive.sh";
const PACKAGE = "@chaine.dance/jive-test-package";
const NPM_TOKEN = "npm-test-token";
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

/** One function over Convex's HTTP API, with `bearer` as the Authorization token when given. */
async function callAction(path: string, args: Record<string, unknown>, bearer?: string): Promise<any> {
  const response = await fetch(`${convexUrl}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return { httpStatus: response.status, body: await response.json().catch(() => null) };
}

/** Signs the job in with its ID token as the bearer, as jive-abstract-library does. */
const signIn = (maybeIdToken: string | undefined) => callAction("pipelineSessions:signIn", {}, maybeIdToken);

/** The session token of a deploy job whose ID token carries `claims` over the defaults. */
async function signedIn(claims: Record<string, unknown>): Promise<string> {
  const { body } = await signIn(await idToken(claims));
  expect(body).toMatchObject({ status: "success", value: { status: "signedIn" } });
  return body.value.sessionToken;
}

const KIND = "connector-package-registry";

/** `provision` by its bare path, the default export of convex/provision.ts, as the jive CLI calls it. */
const provision = (sessionToken: string, input: { kind?: string; instance?: unknown } = {}) =>
  callAction("provision", { sessionToken, kind: input.kind ?? KIND, instance: input.instance ?? { packageName: PACKAGE } });

/** `packages:provision`, which jive-abstract-library 0.8.0 calls until it moves to the CLI. */
const packagesProvision = (sessionToken: string) => callAction("packages:provision", { sessionToken, registry: "npm", packageName: PACKAGE });

/** The registered repository's organization uses the npm connector for packages. */
const configureNpm = (organizationName: string) => convex(["run", "seed:resourceImplementation", JSON.stringify({
  organizationName, kind: KIND, implementation: "jive-resource-connector-package-registry-npm",
})]);

beforeAll(async () => {
  const trusted = await generateGithubActionsJwks();
  signingKey = trusted.signingKey;
  otherSigningKey = (await generateGithubActionsJwks()).signingKey;

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

  await initLocalDeployment({ GITHUB_ACTIONS_JWKS: trusted.jwks, WEBSITE_DOMAIN: "jive.sh", CONNECTION_KEY: TEST_CONNECTION_KEY, NPM_REGISTRY_URL: `http://127.0.0.1:${registry.port}` });

  devServer = await startDevServer();
  convexUrl = devServer.url;

  const seeded = JSON.parse(await convex(["run", "seed:organizationWithRepository", JSON.stringify({ organizationName: "jive-test", repository: REPOSITORY })]));
  expect(seeded.organizationId).toBeString();
  await configureNpm("jive-test");

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

describe("signing a pipeline in", () => {
  test("a call without an ID token is refused", async () => {
    expect(await signIn(undefined)).toMatchObject({ body: { status: "success", value: { status: "refused", reason: expect.stringContaining("no GitHub Actions ID token") } } });
  }, TIMEOUT);

  test("a token for another audience, or signed by a key the deployment does not trust, is rejected by Convex", async () => {
    for (const token of [await idToken({ aud: "https://example.com" }), await idToken({}, otherSigningKey)]) {
      const { body } = await signIn(token);
      expect(body?.status === "success").toBe(false);
    }
  }, TIMEOUT);

  test("a job of a repository nobody registered is refused", async () => {
    expect(await signIn(await idToken({ repository_id: "1" })))
      .toMatchObject({ body: { value: { status: "refused", reason: expect.stringContaining("is not a code repository registered with Jive") } } });
  }, TIMEOUT);

  test("a pull request's job, or a job outside a deploy environment, is refused", async () => {
    expect(await signIn(await idToken({ event_name: "pull_request" })))
      .toMatchObject({ body: { value: { status: "refused", reason: expect.stringContaining("pull_request") } } });
    expect(await signIn(await idToken({ environment: undefined })))
      .toMatchObject({ body: { value: { status: "refused", reason: expect.stringContaining("no GitHub Actions environment") } } });
  }, TIMEOUT);

  test("a deploy job of the registered repository gets a session token for an hour, stored only as its hash, deleted when it expires", async () => {
    const before = Date.now();
    const { body } = await signIn(await idToken({}));
    // Read before toMatchObject: Bun's writes an asymmetric matcher into the object it checks.
    const { sessionToken, expiresAt } = body.value;
    expect(body).toMatchObject({ status: "success", value: { status: "signedIn" } });
    expect(sessionToken).toMatch(/^jive_[A-Za-z0-9_-]{43}$/);
    expect(expiresAt - before).toBeGreaterThan(59 * 60 * 1000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);

    const stored = await convex(["run", "--inline-query", `return await ctx.db.query("pipelineSessions").collect()`]);
    expect(stored).toContain("tokenHash");
    expect(stored).not.toContain(sessionToken);
    const scheduled = await convex(["run", "--inline-query", `return (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.startsWith("pipelineSessions"))`]);
    expect(scheduled).toContain(`"scheduledTime": ${expiresAt}`);
  }, TIMEOUT);

  test("provisioning refuses a made-up token, a person's session, and a pipeline session once it is deleted", async () => {
    const noSession = () => ({ body: { value: { status: "refused", reason: "the session token opens no live session; sign the deploy job in with `jive login --cicd`" } } });
    expect(await provision("jive_not-a-token")).toMatchObject(noSession());

    const person = await registerAccount(new ConvexHttpClient(convexUrl), await createSoftwarePasskey("jive.sh"));
    expect(await provision(person.sessionToken)).toMatchObject({ body: { value: { status: "refused", reason: expect.stringContaining("a person's session cannot provision") } } });

    const sessionToken = await signedIn({});
    const rows = JSON.parse(await convex(["run", "--inline-query", `return (await ctx.db.query("pipelineSessions").collect()).map((row) => row._id)`]));
    for (const id of rows) await convex(["run", "pipelineSessions:deleteSession", JSON.stringify({ id })]);
    expect(await provision(sessionToken)).toMatchObject(noSession());
  }, TIMEOUT);

  test("a pipeline's session token opens no person's session", async () => {
    const client = new ConvexHttpClient(convexUrl);
    const refused = await client.query(api.ssh.publicKey, { sessionToken: await signedIn({}) }).then(() => undefined, (cause: unknown) => cause);
    expect(refused).toBeInstanceOf(ConvexError);
    expect(String((refused as ConvexError<string>).data)).toContain("no live session");
  }, TIMEOUT);
});

describe("provisioning", () => {
  test("a new package answers personNeeded with only npm's second-factor page, publishing nothing", async () => {
    expect(await provision(await signedIn({}))).toEqual({ httpStatus: 200, body: expect.objectContaining({ status: "success", value: {
      status: "personNeeded",
      reason: `npm asks for its security key to publish ${PACKAGE}'s placeholder`,
      url: SECOND_FACTOR_PAGE,
    } }) });
    expect(npm.publishes).toEqual([]);
    expect(npm.oneTimePasswords).toEqual([]);
  }, TIMEOUT);

  test("packages:provision answers the same as refused, naming npm's page", async () => {
    expect((await packagesProvision(await signedIn({}))).body.value).toEqual({
      status: "refused",
      reason: `npm asks for its security key to publish ${PACKAGE}'s placeholder: ${SECOND_FACTOR_PAGE}`,
    });
  }, TIMEOUT);

  test("a package the account maintains, whose publisher for pipeline.yml and the environment has published, is ready with no write to npm, with the same instanceId every time", async () => {
    npm.packages.set(PACKAGE, { maintainers: ["jive-test-account"], publishedBy: ["trust-1"] });
    npm.trust = [{
      id: "trust-1",
      type: "github",
      claims: { repository: "chaine-dance/jive-test-package", workflow_ref: { file: "pipeline.yml" }, environment: "latest" },
    }];
    const first = (await provision(await signedIn({}))).body.value;
    expect(first.status).toBe("ready");
    expect(first.instanceId).toBeString();
    expect(first.instance).toEqual({ packageName: PACKAGE });
    expect((await provision(await signedIn({}))).body.value).toEqual(first);
    expect(await packagesProvision(await signedIn({}))).toMatchObject({ body: { value: { status: "ready" } } });
    expect(npm.publishes).toEqual([]);
    expect(npm.trustRequests).toBe(0);
    expect(npm.oneTimePasswords).toEqual([]);
  }, TIMEOUT);

  test("another deploy job's claim answers inProgress, and the package provisions once it is released", async () => {
    await convex(["run", "--component", "packageRegistryNpm", "resource:claim", JSON.stringify({ packageName: PACKAGE, holder: "another-job" })]);
    expect((await provision(await signedIn({}))).body.value).toEqual({ status: "inProgress", retryAfterSeconds: 10 });
    expect(await packagesProvision(await signedIn({}))).toMatchObject({ body: { value: { status: "inProgress" } } });
    await convex(["run", "--component", "packageRegistryNpm", "resource:release", JSON.stringify({ packageName: PACKAGE, holder: "another-job" })]);
    expect(await provision(await signedIn({}))).toMatchObject({ body: { value: { status: "ready" } } });
  }, TIMEOUT);

  test("another repository asking for the same package name is refused", async () => {
    await convex(["run", "seed:organizationWithRepository", JSON.stringify({
      organizationName: "jive-test",
      repository: { repositoryId: "900003", repositoryOwnerId: REPOSITORY.repositoryOwnerId, owner: "chaine-dance", name: "impostor" },
    })]);
    expect((await provision(await signedIn({ repository_id: "900003", repository: "chaine-dance/impostor" }))).body.value)
      .toEqual({ status: "refused", reason: `${PACKAGE} is provisioned for another code repository` });
  }, TIMEOUT);

  test("an unknown kind, or an instance that isn't { packageName }, is refused", async () => {
    const sessionToken = await signedIn({});
    expect((await provision(sessionToken, { kind: "connector-chat" })).body.value)
      .toEqual({ status: "refused", reason: "\"connector-chat\" is not a resource kind Jive knows; it knows connector-package-registry" });
    expect((await provision(sessionToken, { instance: { name: PACKAGE } })).body.value)
      .toMatchObject({ status: "refused", reason: expect.stringContaining("a connector-package-registry instance is { packageName }") });
  }, TIMEOUT);

  test("an organization with no implementation configured for the kind is refused, then one with no npm connection", async () => {
    // A new organization each run: the local deployment keeps what earlier runs configured.
    const stamp = Date.now();
    const organizationName = `other-org-${stamp}`;
    const other = { repositoryId: `${stamp}1`, repositoryOwnerId: `${stamp}2`, owner: organizationName, name: "app" };
    await convex(["run", "seed:organizationWithRepository", JSON.stringify({ organizationName, repository: other })]);
    const otherJob = { repository_id: other.repositoryId, repository_owner_id: other.repositoryOwnerId, repository: `${organizationName}/app` };
    expect((await provision(await signedIn(otherJob))).body.value)
      .toEqual({ status: "refused", reason: `the organization ${organizationName} has no implementation configured for connector-package-registry` });
    await configureNpm(organizationName);
    expect((await provision(await signedIn(otherJob))).body.value)
      .toEqual({ status: "refused", reason: `the organization ${organizationName} has not connected an npm account to Jive` });
  }, TIMEOUT);

  test("an implementation that isn't installed, or a kind that doesn't exist, cannot be configured", async () => {
    const configure = (kind: string, implementation: string) => run(["bunx", "convex", "run", "seed:resourceImplementation", JSON.stringify({ organizationName: "jive-test", kind, implementation })]);
    expect((await configure(KIND, "jive-resource-connector-package-registry-jsr")).stderr).toContain("is not an installed implementation of connector-package-registry");
    expect((await configure("connector-chat", "jive-resource-connector-chat-slack")).stderr).toContain("is not a resource kind this server knows");
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

  test("the npm token is stored sealed in accountKeys, never in the clear", async () => {
    const stored = await convex(["run", "--component", "accountKeys", "--inline-query", `return await ctx.db.query("npmConnections").collect()`]);
    expect(stored).toContain("sealedToken");
    expect(stored).not.toContain(NPM_TOKEN);
  }, TIMEOUT);
});
