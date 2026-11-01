import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { Effect } from "effect";
import { api } from "../convex/_generated/api";
import { generateSshKey } from "../convex/components/accountKeys/sshKeys";
import { parseConnectionKey, seal } from "../convex/model/sealing";
import { registerAccount } from "./support/accounts";
import { SERVER_DIR, TEST_CONNECTION_KEY, TIMEOUT, convex, generateGithubActionsJwks, initLocalDeployment, run as convexCli, startDevServer, type DevServer } from "./support/localBackend";
import { createSoftwarePasskey } from "./support/softwareAuthenticator";

/**
 * Signing with the account's SSH key, end to end on the local backend: a signed-in account creates its key, then
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

/** SSH's wire `string`. */
function sshString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}
const text = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: ReadonlyArray<Uint8Array>) => Uint8Array.from(parts.flatMap((part) => [...part]));

async function sign(sessionToken: string, data: Uint8Array): Promise<Uint8Array> {
  const { signature } = await client.action(api.ssh.sign, { sessionToken, data: data.slice().buffer });
  return new Uint8Array(signature);
}

/** The key blob in an OpenSSH public key line. */
const keyBlobOf = (publicKey: string) => new Uint8Array(Buffer.from(publicKey.split(" ")[1]!, "base64"));

async function run(command: ReadonlyArray<string>, stdin?: Uint8Array) {
  const child = Bun.spawn([...command], { cwd: SCRATCH_DIR, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined && typeof child.stdin !== "number" && child.stdin !== undefined) {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function refusal(call: Promise<unknown>): Promise<string> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ConvexError);
  return String((error as ConvexError<string>).data);
}

describe("the account's SSH key", () => {
  test("is created once, as an ed25519 OpenSSH public key that ssh-keygen reads", async () => {
    const sessionToken = await signedIn();
    expect(await client.query(api.ssh.publicKey, { sessionToken })).toBeNull();
    const { publicKey } = await client.action(api.ssh.createKey, { sessionToken });
    expect(publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* [a-z]+-[a-z]+-[a-z]+@jive\.sh$/);
    expect(await client.action(api.ssh.createKey, { sessionToken })).toEqual({ publicKey });
    expect(await client.query(api.ssh.publicKey, { sessionToken })).toEqual({ publicKey });
    writeFileSync(resolve(SCRATCH_DIR, "key.pub"), `${publicKey}\n`);
    const fingerprint = await run(["ssh-keygen", "-l", "-f", "key.pub"]);
    expect(fingerprint.exitCode, fingerprint.output).toBe(0);
    expect(fingerprint.output).toContain("(ED25519)");

    const other = await client.action(api.ssh.createKey, { sessionToken: await signedIn() });
    expect(other.publicKey.split(" ")[1]).not.toBe(publicKey.split(" ")[1]);
  }, TIMEOUT);

  test("is stored sealed under CONNECTION_KEY", async () => {
    const sessionToken = await signedIn();
    await client.action(api.ssh.createKey, { sessionToken });
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
    const { publicKey } = await client.action(api.ssh.createKey, { sessionToken });
    const commit = text("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Jive <a@jive.sh> 1793522489 +0000\n\nsigned on the server\n");

    // PROTOCOL.sshsig: the agent is asked to sign this blob, and the armored signature wraps its answer.
    const namespace = text("git");
    const messageHash = new Uint8Array(await crypto.subtle.digest("SHA-512", commit));
    const signedData = concat(text("SSHSIG"), sshString(namespace), sshString(new Uint8Array()), sshString(text("sha512")), sshString(messageHash));
    const signature = await sign(sessionToken, signedData);
    const armored = concat(
      text("SSHSIG"), Uint8Array.from([0, 0, 0, 1]), sshString(keyBlobOf(publicKey)), sshString(namespace),
      sshString(new Uint8Array()), sshString(text("sha512")), sshString(signature),
    );
    const lines = Buffer.from(armored).toString("base64").match(/.{1,70}/g)!;
    writeFileSync(resolve(SCRATCH_DIR, "commit.sig"), `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`);
    writeFileSync(resolve(SCRATCH_DIR, "allowed_signers"), `alex@jive.sh ${publicKey.split(" ").slice(0, 2).join(" ")}\n`);

    const verified = await run(["ssh-keygen", "-Y", "verify", "-f", "allowed_signers", "-I", "alex@jive.sh", "-n", "git", "-s", "commit.sig"], commit);
    expect(verified.exitCode, verified.output).toBe(0);
    expect(verified.output).toContain('Good "git" signature for alex@jive.sh');

    const tampered = await run(["ssh-keygen", "-Y", "verify", "-f", "allowed_signers", "-I", "alex@jive.sh", "-n", "git", "-s", "commit.sig"], text("another commit"));
    expect(tampered.exitCode).not.toBe(0);
  }, TIMEOUT);

  test("signs an SSH authentication blob, verifiable with the account's public key", async () => {
    const sessionToken = await signedIn();
    const { publicKey } = await client.action(api.ssh.createKey, { sessionToken });
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

  test("refuses a made-up or revoked session, and an account with no key", async () => {
    const data = text("anything").buffer;
    expect(await refusal(client.action(api.ssh.sign, { sessionToken: "jive_not-a-token", data }))).toContain("no live session");

    const withoutKey = await signedIn();
    expect(await refusal(client.action(api.ssh.sign, { sessionToken: withoutKey, data }))).toContain("no SSH key");

    const sessionToken = await signedIn();
    await client.action(api.ssh.createKey, { sessionToken });
    await client.mutation(api.sessions.signOut, { sessionToken });
    expect(await refusal(client.action(api.ssh.sign, { sessionToken, data }))).toContain("no live session");
    expect(await refusal(client.action(api.ssh.createKey, { sessionToken }))).toContain("no live session");
  }, TIMEOUT);
});

describe("a key written before the component", () => {
  const callerOf = async (sessionToken: string) =>
    JSON.parse(await convex(["run", "ssh:caller", JSON.stringify({ sessionToken })])) as { accountId: string; username: string };

  /** A real ed25519 key, sealed the way production stored one, inserted as this account's pre-component row. */
  const plantLegacy = async (sessionToken: string) => {
    const caller = await callerOf(sessionToken);
    const generated = await generateSshKey(`${caller.username}@jive.sh`);
    const connectionKey = await Effect.runPromise(parseConnectionKey(TEST_CONNECTION_KEY));
    const sealedPrivateKey = await Effect.runPromise(seal(connectionKey, generated.privateKeyPkcs8));
    const row = {
      accountId: caller.accountId,
      publicKey: generated.publicKey,
      sealedPrivateKey,
      keyVersion: connectionKey.version,
      createdAt: 1_700_000_000_000,
    };
    await convex(["run", "ssh:insertLegacy", JSON.stringify(row)]);
    return row;
  };

  const storedSeal = async (sessionToken: string) =>
    JSON.parse(await convex(["run", "ssh:sealedKey", JSON.stringify({ sessionToken })])) as {
      sealed: { sealedPrivateKey: string; keyVersion: number };
    };

  const verifies = async (publicKey: string, data: Uint8Array, signature: Uint8Array) => {
    const view = new DataView(signature.buffer, signature.byteOffset, signature.byteLength);
    const raw = new Uint8Array(signature.slice(8 + view.getUint32(0)));
    const rawPublicKey = new Uint8Array(keyBlobOf(publicKey).slice(4 + 11 + 4));
    const payload = new Uint8Array(data);
    const key = await crypto.subtle.importKey("raw", rawPublicKey, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, raw, payload);
  };

  test("createKey returns that key and signs with it, and a second call does not mint another", async () => {
    const sessionToken = await signedIn();
    const legacy = await plantLegacy(sessionToken);
    expect(await client.query(api.ssh.publicKey, { sessionToken })).toBeNull();
    const { publicKey } = await client.action(api.ssh.createKey, { sessionToken });
    expect(publicKey).toBe(legacy.publicKey);
    expect(await client.action(api.ssh.createKey, { sessionToken })).toEqual({ publicKey });
    expect(await client.query(api.ssh.publicKey, { sessionToken })).toEqual({ publicKey });
    expect(await storedSeal(sessionToken)).toEqual({ sealed: { sealedPrivateKey: legacy.sealedPrivateKey, keyVersion: legacy.keyVersion } });
    const data = text("the key that was already there");
    expect(await verifies(publicKey, data, await sign(sessionToken, data))).toBe(true);
  }, TIMEOUT);

  test("the deploy migration copies every row once, still sealed", async () => {
    const sessionToken = await signedIn();
    const legacy = await plantLegacy(sessionToken);
    const args = JSON.stringify({ sourceCommitSha: "migration-test", environment: "latest" });
    const first = JSON.parse(await convex(["run", "ssh:migrateToAccountKeys", args])) as { copied: number; alreadyPresent: number };
    expect(first.copied).toBeGreaterThanOrEqual(1);
    const second = JSON.parse(await convex(["run", "ssh:migrateToAccountKeys", args])) as { copied: number; alreadyPresent: number };
    expect(second.copied).toBe(0);
    expect(second.alreadyPresent).toBe(first.copied + first.alreadyPresent);
    expect(await storedSeal(sessionToken)).toEqual({ sealed: { sealedPrivateKey: legacy.sealedPrivateKey, keyVersion: legacy.keyVersion } });
    expect(await client.action(api.ssh.createKey, { sessionToken })).toEqual({ publicKey: legacy.publicKey });
    const data = text("copied by the migration");
    expect(await verifies(legacy.publicKey, data, await sign(sessionToken, data))).toBe(true);
  }, TIMEOUT);

  test("a different public key already stored is left as it is", async () => {
    const sessionToken = await signedIn();
    const { publicKey } = await client.action(api.ssh.createKey, { sessionToken });
    const before = await storedSeal(sessionToken);
    const caller = await callerOf(sessionToken);
    try {
      await convex(["run", "ssh:insertLegacy", JSON.stringify({
        accountId: caller.accountId,
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA not-the-stored-key@jive.sh",
        sealedPrivateKey: "aaaaaaaaaaaaaaaa.not-the-stored-ciphertext",
        keyVersion: 1,
        createdAt: 1,
      })]);
      const migrated = await convexCli(["bunx", "convex", "run", "ssh:migrateToAccountKeys", JSON.stringify({ sourceCommitSha: "mismatch", environment: "latest" })]);
      expect(migrated.exitCode, `${migrated.stdout}\n${migrated.stderr}`).not.toBe(0);
      expect(`${migrated.stdout}\n${migrated.stderr}`).toContain("different SSH key");
      expect(await client.query(api.ssh.publicKey, { sessionToken })).toEqual({ publicKey });
      expect(await storedSeal(sessionToken)).toEqual(before);
      expect(await refusal(client.action(api.ssh.createKey, { sessionToken }))).toContain("different SSH key");
    } finally {
      await convex(["run", "ssh:removeLegacy", JSON.stringify({ accountId: caller.accountId })]);
    }
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
