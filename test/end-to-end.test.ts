import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { SESSION_MS } from "../convex/model/sessions";
import { sha256Hex } from "../convex/model/tokens";
import { registerAccount } from "./support/accounts";
import { SERVER_DIR, TEST_CONNECTION_KEY, TIMEOUT, convex, generateGithubActionsJwks, initLocalDeployment, startDevServer, type DevServer } from "./support/localBackend";
import { createSoftwarePasskey } from "./support/softwareAuthenticator";
import { gitSignedData, text, verifyGitSignature } from "./support/sshSignature";

/**
 * The whole path a person and their machine take, on the local backend, through the public API only (except
 * writing a session that is already past its expiry, which no call can make without waiting a day): sign up with a
 * passkey, sign a program in through a sign-in request, fetch the account's SSH key, sign a git commit with it,
 * and the session rule (a day after each use; Alex, 2026-11-06).
 */

/** Where this test writes the files it hands ssh-keygen and convex import; gitignored and deleted afterwards. */
const SCRATCH_DIR = resolve(SERVER_DIR, ".test-end-to-end");

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

async function refusal(call: Promise<unknown>): Promise<string> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ConvexError);
  return String((error as ConvexError<string>).data);
}

test("sign-up makes the SSH key; a program signed in by a passkey fetches it and signs a commit ssh-keygen verifies; each use moves the session's end to a day later, and a session past its end is refused", async () => {
  // Sign-up: the account has its key the moment register returns.
  const passkey = await createSoftwarePasskey("jive.sh");
  const browser = await registerAccount(client, passkey);
  const { publicKey } = await client.query(api.ssh.publicKey, { sessionToken: browser.sessionToken });
  expect(publicKey).toMatch(new RegExp(`^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI\\S+ ${browser.username}@jive\\.sh$`));

  // A program (jive login) opens a sign-in request; the person approves it with the passkey; the program claims it.
  const request = await client.action(api.signInRequests.open, {});
  expect(await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret })).toEqual({ status: "pending" });
  const { options } = await client.action(api.auth.signInOptions, {});
  await client.action(api.auth.signIn, { challenge: options.challenge, response: await passkey.signIn(options), signInRequestId: request.requestId });
  const claimedAt = Date.now();
  const claimed = await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret });
  if (claimed.status !== "approved") throw new Error(`the approved request was not claimed: ${claimed.status}`);
  expect(claimed.expiresAt).toBeGreaterThanOrEqual(claimedAt + SESSION_MS - 5_000);
  expect(claimed.expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_MS);
  const program = claimed.sessionToken;

  // The program fetches the same key; asking is a query and moves nothing.
  expect(await client.query(api.ssh.publicKey, { sessionToken: program })).toEqual({ publicKey });
  expect((await client.query(api.accounts.me, { sessionToken: program }))?.sessionExpiresAt).toBe(claimed.expiresAt);

  // Signing is a use: the commit verifies with ssh-keygen, and the session now ends a day after the signature.
  await Bun.sleep(1_500);
  const commit = text("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Jive <a@jive.sh> 1793522489 +0000\n\nsigned end to end\n");
  const signedAt = Date.now();
  const { signature } = await client.action(api.ssh.sign, { sessionToken: program, data: (await gitSignedData(commit)).slice().buffer });
  const verified = await verifyGitSignature({ directory: SCRATCH_DIR, publicKey, signature: new Uint8Array(signature), message: commit });
  expect(verified.exitCode, verified.output).toBe(0);
  expect(verified.output).toContain('Good "git" signature for alex@jive.sh');
  const extendedTo = (await client.query(api.accounts.me, { sessionToken: program }))!.sessionExpiresAt;
  expect(extendedTo).toBeGreaterThan(claimed.expiresAt);
  expect(extendedTo).toBeGreaterThanOrEqual(signedAt + SESSION_MS);
  expect(extendedTo).toBeLessThanOrEqual(Date.now() + SESSION_MS);
  // Only the session that signed moved: the browser's is where sign-up left it.
  expect((await client.query(api.accounts.me, { sessionToken: browser.sessionToken }))!.sessionExpiresAt).toBe(browser.expiresAt);

  // A session of the same account whose end has passed signs nothing and reads nothing, and isn't revived.
  const accounts = JSON.parse(await convex(["run", "ssh:accounts", "{}"])) as Array<{ accountId: string; username: string }>;
  const accountId = accounts.find((account) => account.username === browser.username)!.accountId;
  const ended = `jive_ended-${crypto.randomUUID()}`;
  const now = Date.now();
  const rows = resolve(SCRATCH_DIR, "ended-session.jsonl");
  writeFileSync(rows, `${JSON.stringify({ accountId, tokenHash: await sha256Hex(ended), origin: "signInRequest", createdAt: now - 2 * SESSION_MS, expiresAt: now - 1_000 })}\n`);
  await convex(["import", "--table", "sessions", "--append", "--yes", rows]);
  expect(await refusal(client.action(api.ssh.sign, { sessionToken: ended, data: text("anything").slice().buffer }))).toContain("no live session");
  expect(await refusal(client.query(api.ssh.publicKey, { sessionToken: ended }))).toContain("no live session");
  expect(await client.query(api.accounts.me, { sessionToken: ended })).toBeNull();
}, TIMEOUT);
