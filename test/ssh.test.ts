import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { registerAccount } from "./support/accounts";
import { SERVER_DIR, TEST_CONNECTION_KEY, TIMEOUT, convex, generateGithubActionsJwks, initLocalDeployment, startDevServer, type DevServer } from "./support/localBackend";
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
