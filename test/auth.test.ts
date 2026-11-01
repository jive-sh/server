import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { TIMEOUT, convex, generateGithubActionsJwks, initLocalDeployment, startDevServer, type DevServer } from "./support/localBackend";
import { registerAccount } from "./support/accounts";
import { createSoftwarePasskey, type SoftwarePasskey } from "./support/softwareAuthenticator";

/**
 * Passkey sign-in, sessions and program sign-in requests end to end, inside Convex's runtime: the functions pushed
 * to an anonymous local backend with `WEBSITE_DOMAIN=jive.sh`, called through `ConvexHttpClient` (what a CLI or
 * daemon uses), with a software passkey producing real WebAuthn responses so `@simplewebauthn/server` verifies them
 * for real.
 */

let devServer: DevServer | undefined;
let client: ConvexHttpClient;

beforeAll(async () => {
  await initLocalDeployment({ GITHUB_ACTIONS_JWKS: (await generateGithubActionsJwks()).jwks, WEBSITE_DOMAIN: "jive.sh" });
  devServer = await startDevServer();
  client = new ConvexHttpClient(devServer.url);
}, TIMEOUT);

afterAll(async () => {
  await devServer?.stop();
});

const register = (passkey: SoftwarePasskey, signInRequestId?: string) => registerAccount(client, passkey, signInRequestId);

async function signIn(passkey: SoftwarePasskey, input: { readonly signInRequestId?: string; readonly origin?: string } = {}) {
  const { options } = await client.action(api.auth.signInOptions, {});
  const response = await passkey.signIn(options, input.origin);
  return await client.action(api.auth.signIn, {
    challenge: options.challenge,
    response,
    ...(input.signInRequestId === undefined ? {} : { signInRequestId: input.signInRequestId }),
  });
}

/** The ConvexError message a refused call carries, which is what the page shows. */
async function refusal(call: Promise<unknown>): Promise<string> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ConvexError);
  return String((error as ConvexError<string>).data);
}

describe("registration and sign-in", () => {
  test("registering creates an account with its passkey and a working session", async () => {
    const passkey = await createSoftwarePasskey("jive.sh");
    const opened = await register(passkey);
    expect(opened.sessionToken).toStartWith("jive_");
    expect(opened.username).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const me = await client.query(api.accounts.me, { sessionToken: opened.sessionToken });
    expect(me).toMatchObject({ username: opened.username, passkeys: [{ credentialId: passkey.credentialId }] });
  }, TIMEOUT);

  test("signing in with a registered passkey opens a new session for the same account", async () => {
    const passkey = await createSoftwarePasskey("jive.sh");
    const registered = await register(passkey);
    const signedIn = await signIn(passkey);
    expect(signedIn.sessionToken).not.toBe(registered.sessionToken);
    expect(signedIn.username).toBe(registered.username);
    expect(await client.query(api.accounts.me, { sessionToken: signedIn.sessionToken })).toMatchObject({ username: registered.username });
  }, TIMEOUT);

  test("an unregistered passkey, another origin, or a reused challenge is refused", async () => {
    const stranger = await createSoftwarePasskey("jive.sh");
    expect(await refusal(signIn(stranger))).toContain("not registered");

    const passkey = await createSoftwarePasskey("jive.sh");
    await register(passkey);
    expect(await refusal(signIn(passkey, { origin: "https://evil.example" }))).toContain("could not be verified");

    const { options } = await client.action(api.auth.signInOptions, {});
    const response = await passkey.signIn(options);
    await client.action(api.auth.signIn, { challenge: options.challenge, response });
    expect(await refusal(client.action(api.auth.signIn, { challenge: options.challenge, response }))).toContain("expired");
  }, TIMEOUT);

  test("a made-up session token opens nothing, and signing out revokes a session at once", async () => {
    expect(await client.query(api.accounts.me, { sessionToken: "jive_not-a-token" })).toBeNull();
    const opened = await register(await createSoftwarePasskey("jive.sh"));
    await client.mutation(api.sessions.signOut, { sessionToken: opened.sessionToken });
    expect(await client.query(api.accounts.me, { sessionToken: opened.sessionToken })).toBeNull();
  }, TIMEOUT);

  test("a passkey imported from skill-sync signs in to the account made for it", async () => {
    const passkey = await createSoftwarePasskey("jive.sh");
    const imported = JSON.parse(await convex(["run", "seed:accountWithPasskey", JSON.stringify({
      webAuthnUserId: crypto.randomUUID(),
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      passkeyCreatedAt: 1792648583208,
    })]));
    expect(imported.created).toBe(true);
    const signedIn = await signIn(passkey);
    expect(signedIn.username).toBe(imported.username);
    const again = JSON.parse(await convex(["run", "seed:accountWithPasskey", JSON.stringify({
      webAuthnUserId: crypto.randomUUID(),
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      passkeyCreatedAt: 1792648583208,
    })]));
    expect(again).toEqual({ username: imported.username, created: false });
  }, TIMEOUT);
});

describe("a program signing in through a sign-in request", () => {
  test("the person approves with a passkey and the program claims a session of its own, once", async () => {
    const passkey = await createSoftwarePasskey("jive.sh");
    const registered = await register(passkey);

    const request = await client.action(api.signInRequests.open, {});
    expect(request.loginUrl).toBe(`https://jive.sh/login?request=${request.requestId}`);
    expect(request.claimSecret).toStartWith("jive_claim_");
    expect(await client.query(api.signInRequests.describe, { requestId: request.requestId }))
      .toEqual({ confirmationCode: request.confirmationCode, status: "pending" });
    expect(await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret }))
      .toEqual({ status: "pending" });

    const browser = await signIn(passkey, { signInRequestId: request.requestId });
    expect(await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: "jive_claim_wrong" }))
      .toEqual({ status: "gone" });
    const claimed = await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret });
    if (claimed.status !== "approved") throw new Error(`expected approved, got ${claimed.status}`);
    expect(claimed.sessionToken).not.toBe(browser.sessionToken);
    expect(await client.query(api.accounts.me, { sessionToken: claimed.sessionToken })).toMatchObject({ username: registered.username });

    expect(await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret }))
      .toEqual({ status: "gone" });
    expect(await client.query(api.signInRequests.describe, { requestId: request.requestId })).toBeNull();
  }, TIMEOUT);

  test("a request already approved cannot be approved again, and the second ceremony opens no session", async () => {
    const passkey = await createSoftwarePasskey("jive.sh");
    await register(passkey);
    const request = await client.action(api.signInRequests.open, {});
    await signIn(passkey, { signInRequestId: request.requestId });
    expect(await refusal(signIn(passkey, { signInRequestId: request.requestId }))).toContain("expired or was already used");
    expect(await client.query(api.signInRequests.describe, { requestId: "not-an-id" })).toBeNull();
  }, TIMEOUT);

  test("registering from the login page approves the request too", async () => {
    const request = await client.action(api.signInRequests.open, {});
    const registered = await register(await createSoftwarePasskey("jive.sh"), request.requestId);
    const claimed = await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret });
    if (claimed.status !== "approved") throw new Error(`expected approved, got ${claimed.status}`);
    expect(await client.query(api.accounts.me, { sessionToken: claimed.sessionToken })).toMatchObject({ username: registered.username });
  }, TIMEOUT);
});
