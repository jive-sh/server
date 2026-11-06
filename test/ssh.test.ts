import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { registerAccount } from "./support/accounts";
import { SERVER_DIR, TEST_CONNECTION_KEY, TIMEOUT, convex, generateGithubActionsJwks, initLocalDeployment, startDevServer, type DevServer } from "./support/localBackend";
import { createSoftwarePasskey } from "./support/softwareAuthenticator";
import { concat, gitSignedData, keyBlobOf, runInDirectory, sshString, text, verifyGitSignature } from "./support/sshSignature";

/**
 * Signing with the account's SSH key, end to end on the local backend: an account has its key from sign-up, and
 * signs what a local SSH agent would forward. A git commit signature is assembled the way `ssh-keygen -Y sign`
 * assembles one over an agent and checked by the real `ssh-keygen`; an authentication signature is checked against
 * the OpenSSH public key with Web Crypto.
 */

/** Where this test writes the files it hands ssh-keygen; gitignored and deleted afterwards. */
const SCRATCH_DIR = resolve(SERVER_DIR, ".test-ssh");

let devServer: DevServer | undefined;
let client: ConvexHttpClient;

beforeAll(async () => {
  await initLocalDeployment({ GITHUB_ACTIONS_JWKS: (await generateGithubActionsJwks()).jwks, WEBSITE_DOMAIN: "jive.sh", CONNECTION_KEY: TEST_CONNECTION_KEY });
  devServer = await startDevServer();
  client = new ConvexHttpClient(devServer.url);
  mkdirSync(SCRATCH_DIR, { recursive: true });
}, TIMEOUT);

afterAll(async () => {
  await devServer?.stop();
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

const signedIn = async () => (await registerAccount(client, await createSoftwarePasskey("jive.sh"))).sessionToken;

async function sign(sessionToken: string, data: Uint8Array): Promise<Uint8Array> {
  const { signature } = await client.action(api.ssh.sign, { sessionToken, data: data.slice().buffer });
  return new Uint8Array(signature);
}

const run = (command: ReadonlyArray<string>) => runInDirectory({ directory: SCRATCH_DIR, command });

async function refusal(call: Promise<unknown>): Promise<string> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ConvexError);
  return String((error as ConvexError<string>).data);
}

describe("the account's SSH key", () => {
  test("exists as soon as sign-up returns, as an ed25519 OpenSSH public key that ssh-keygen reads", async () => {
    const sessionToken = await signedIn();
    const { publicKey } = await client.query(api.ssh.publicKey, { sessionToken });
    expect(publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* [a-z]+-[a-z]+-[a-z]+@jive\.sh$/);
    expect(await client.query(api.ssh.publicKey, { sessionToken })).toEqual({ publicKey });
    writeFileSync(resolve(SCRATCH_DIR, "key.pub"), `${publicKey}\n`);
    const fingerprint = await run(["ssh-keygen", "-l", "-f", "key.pub"]);
    expect(fingerprint.exitCode, fingerprint.output).toBe(0);
    expect(fingerprint.output).toContain("(ED25519)");

    const other = await client.query(api.ssh.publicKey, { sessionToken: await signedIn() });
    expect(other.publicKey.split(" ")[1]).not.toBe(publicKey.split(" ")[1]);
  }, TIMEOUT);

  test("is stored sealed under CONNECTION_KEY", async () => {
    const sessionToken = await signedIn();
    const stored = JSON.parse(await convex(["run", "ssh:sealedKey", JSON.stringify({ sessionToken })]));
    expect(stored.sealed.keyVersion).toBe(1);
    expect(stored.sealed.sealedPrivateKey).toMatch(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    // A PKCS#8 Ed25519 key in the clear starts with this DER prefix, base64 "MC4CAQAwBQYDK2Vw".
    expect(stored.sealed.sealedPrivateKey).not.toContain("MC4CAQAwBQYDK2Vw");
  }, TIMEOUT);
});

describe("signing", () => {
  test("signs a git commit: the SSHSIG signature ssh-keygen -Y sign would build over an agent checks out", async () => {
    const sessionToken = await signedIn();
    const { publicKey } = await client.query(api.ssh.publicKey, { sessionToken });
    const commit = text("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Jive <a@jive.sh> 1793522489 +0000\n\nsigned on the server\n");

    const signature = await sign(sessionToken, await gitSignedData(commit));

    const verified = await verifyGitSignature({ directory: SCRATCH_DIR, publicKey, signature, message: commit });
    expect(verified.exitCode, verified.output).toBe(0);
    expect(verified.output).toContain('Good "git" signature for alex@jive.sh');

    const tampered = await verifyGitSignature({ directory: SCRATCH_DIR, publicKey, signature, message: text("another commit") });
    expect(tampered.exitCode).not.toBe(0);
  }, TIMEOUT);

  test("signs an SSH authentication blob, verifiable with the account's public key", async () => {
    const sessionToken = await signedIn();
    const { publicKey } = await client.query(api.ssh.publicKey, { sessionToken });
    // RFC 4252 §7's signed data: session id, SSH_MSG_USERAUTH_REQUEST, user, service, "publickey", TRUE, algorithm, key.
    const blob = concat(sshString(crypto.getRandomValues(new Uint8Array(32))), Uint8Array.from([50]), sshString(text("git")),
      sshString(text("ssh-connection")), sshString(text("publickey")), Uint8Array.from([1]), sshString(text("ssh-ed25519")), sshString(keyBlobOf(publicKey)));
    const signature = await sign(sessionToken, blob);

    const view = new DataView(signature.buffer, signature.byteOffset);
    const algorithmLength = view.getUint32(0);
    expect(new TextDecoder().decode(signature.slice(4, 4 + algorithmLength))).toBe("ssh-ed25519");
    const raw = signature.slice(8 + algorithmLength);
    expect(raw.length).toBe(64);
    const rawPublicKey = keyBlobOf(publicKey).slice(4 + 11 + 4);
    const key = await crypto.subtle.importKey("raw", rawPublicKey, { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, raw, blob)).toBe(true);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, raw, concat(blob, Uint8Array.from([0])))).toBe(false);
  }, TIMEOUT);

  test("refuses a made-up or revoked session", async () => {
    const data = text("anything").buffer;
    expect(await refusal(client.action(api.ssh.sign, { sessionToken: "jive_not-a-token", data }))).toContain("no live session");

    const sessionToken = await signedIn();
    await client.mutation(api.sessions.signOut, { sessionToken });
    expect(await refusal(client.action(api.ssh.sign, { sessionToken, data }))).toContain("no live session");
    expect(await refusal(client.query(api.ssh.publicKey, { sessionToken }))).toContain("no live session");
  }, TIMEOUT);
});

describe("every account has its key", () => {
  test("an account the seed command creates gets its key too", async () => {
    const webAuthnUserId = crypto.randomUUID();
    const seeded = JSON.parse(await convex(["run", "seed:accountWithPasskey", JSON.stringify({
      webAuthnUserId, credentialId: `seeded-${webAuthnUserId}`, publicKey: "not-used-here", passkeyCreatedAt: 1,
    })])) as { username: string; created: boolean };
    expect(seeded.created).toBe(true);
    const accounts = async () => JSON.parse(await convex(["run", "ssh:accounts", "{}"])) as Array<{ accountId: string; username: string }>;
    const seededAccount = (await accounts()).find((account) => account.username === seeded.username)!;
    // The seed is a mutation, so the key is made by the action it schedules; wait for it.
    let key = null;
    for (let attempt = 0; attempt < 20 && key === null; attempt += 1) {
      key = JSON.parse(await convex(["run", "--component", "accountKeys", "ssh:publicKey", JSON.stringify({ accountId: seededAccount.accountId })]));
      if (key === null) await Bun.sleep(500);
    }
    expect(key).toMatchObject({ publicKey: expect.stringMatching(new RegExp(`^ssh-ed25519 \\S+ ${seeded.username}@jive\\.sh$`)) });
  }, TIMEOUT);

  test("the deploy's after-deploy step finds every account with a key, and creates none twice", async () => {
    const args = JSON.stringify({ sourceCommitSha: "after-deploy-test", environment: "latest" });
    const first = JSON.parse(await convex(["run", "ssh:afterDeploy", args])) as { accounts: number; created: number };
    expect(first.accounts).toBeGreaterThan(0);
    const second = JSON.parse(await convex(["run", "ssh:afterDeploy", args])) as { accounts: number; created: number };
    expect(second).toEqual({ accounts: first.accounts, created: 0 });
  }, TIMEOUT);
});

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

describe("the organization's npm connection", () => {
  const seed = async (name: string) => {
    const unique = `${name}-${crypto.randomUUID()}`;
    const repository = { repositoryId: `repo-${unique}`, repositoryOwnerId: `owner-${unique}`, owner: "jive-sh", name: unique };
    const seeded = JSON.parse(await convex(["run", "seed:organizationWithRepository", JSON.stringify({
      organizationName: unique,
      repository,
    })])) as { organizationId: string };
    return { organizationId: seeded.organizationId, repositoryOwner: repository.owner, repositoryName: repository.name };
  };

  test("saves the token on the repository's organization, and the component returns it", async () => {
    const seeded = await seed("account-keys-token");
    const sessionToken = await signedIn();
    const args = { sessionToken, repositoryOwner: seeded.repositoryOwner, repositoryName: seeded.repositoryName };
    const organizationId = seeded.organizationId;
    // `convex run` prints nothing when the function returns null.
    const before = await convex(["run", "npmConnection:token", JSON.stringify({ organizationId }), "--component", "accountKeys"]);
    expect(before.trim()).toBe("");
    expect(await client.query(api.npmSessions.status, args)).toEqual({ hasToken: false, passkeyRegistered: false });
    await client.action(api.npmSessions.save, { ...args, token: "npm-token-value" });
    expect(await client.action(api.npmSessions.token, args)).toEqual({ token: "npm-token-value" });
    expect(await client.query(api.npmSessions.status, args)).toEqual({ hasToken: true, passkeyRegistered: false });
    const fromComponent = JSON.parse(await convex(["run", "npmConnection:token", JSON.stringify({ organizationId }), "--component", "accountKeys"]));
    expect(fromComponent).toEqual({ token: "npm-token-value" });
  }, TIMEOUT);

  test("the signing passkey signs a challenge, and a dead session is refused", async () => {
    const seeded = await seed("account-keys-passkey");
    const sessionToken = await signedIn();
    const args = { sessionToken, repositoryOwner: seeded.repositoryOwner, repositoryName: seeded.repositoryName };
    const organizationId = seeded.organizationId;
    await client.action(api.npmSessions.save, { ...args, token: "npm-token-value" });
    const challenge = btoa("ceremony");
    expect(await refusal(client.action(api.signingPasskey.sign, { ...args, challenge }))).toContain("no signing passkey");

    const ensured = await client.action(api.signingPasskey.ensure, args);
    expect(await client.action(api.signingPasskey.ensure, args)).toEqual(ensured);
    const { signature } = await client.action(api.signingPasskey.sign, { ...args, challenge });
    const publicKey = await crypto.subtle.importKey("spki", fromBase64(ensured.publicKeySpki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signedBytes = fromBase64(signature);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signedBytes, text("ceremony"))).toBe(true);

    const fromComponent = JSON.parse(await convex(["run", "npmConnection:sign", JSON.stringify({
      organizationId,
      challenge: { $bytes: challenge },
    }), "--component", "accountKeys"])) as { credentialId: string; signature: { $bytes: string } };
    expect(fromComponent.credentialId).toBe(ensured.credentialId);
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromBase64(fromComponent.signature.$bytes),
      text("ceremony"),
    )).toBe(true);

    await client.action(api.npmSessions.markPasskeyRegistered, args);
    expect(await client.query(api.npmSessions.status, args)).toEqual({ hasToken: true, passkeyRegistered: true });

    await client.mutation(api.sessions.signOut, { sessionToken });
    expect(await refusal(client.action(api.npmSessions.token, args))).toContain("no live session");
    expect(await refusal(client.action(api.signingPasskey.sign, { ...args, challenge }))).toContain("no live session");
  }, TIMEOUT);

  test("an unregistered repository is not a dead session", async () => {
    const sessionToken = await signedIn();
    const reason = await refusal(client.action(api.npmSessions.save, {
      sessionToken,
      repositoryOwner: "nobody",
      repositoryName: "missing",
      token: "npm-token-value",
    }));
    expect(reason).not.toContain("no live session");
    expect(reason).toContain("not registered");
  }, TIMEOUT);
});
