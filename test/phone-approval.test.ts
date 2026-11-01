import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { androidOriginOfFingerprint } from "../convex/model/androidApps";
import { registerAccount } from "./support/accounts";
import { TIMEOUT, generateGithubActionsJwks, initLocalDeployment, startDevServer, type DevServer } from "./support/localBackend";
import { createSoftwarePasskey, type SoftwarePasskey } from "./support/softwareAuthenticator";

/**
 * Phone approval end to end, inside Convex's runtime: a person registers on the website, the Jive app on their
 * Android phone signs in with the same (synced) passkey and turns on phone approval, a program opens a sign-in
 * request naming the account by its last session token, the push reaches a fake Expo push service, and the phone's
 * passkey ceremony, with the app's `android:apk-key-hash:` origin, approves it so the program claims its session.
 * A fake website serves `/.well-known/assetlinks.json`, which is what admits the app's origin.
 */

/** A made-up signing certificate's SHA-256, as EAS and assetlinks.json write it. */
const APP_FINGERPRINT = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0").toUpperCase()).join(":");
const APP_ORIGIN = androidOriginOfFingerprint(APP_FINGERPRINT);
const OTHER_APP_ORIGIN = androidOriginOfFingerprint(Array.from({ length: 32 }, () => "AB").join(":"));

interface PushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: { readonly kind: string; readonly requestId: string };
  readonly priority: string;
  readonly ttl: number;
  readonly channelId: string;
}

let fakes: ReturnType<typeof Bun.serve>;
let pushed: Array<PushMessage> = [];
/** Tokens the fake push service answers `DeviceNotRegistered` for, as Expo does after an uninstall. */
const uninstalled = new Set<string>();
let devServer: DevServer | undefined;
let client: ConvexHttpClient;

beforeAll(async () => {
  fakes = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/assetlinks.json") {
        return Response.json([
          {
            relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
            target: { namespace: "android_app", package_name: "sh.jive.app", sha256_cert_fingerprints: [APP_FINGERPRINT] },
          },
          // Only App Links, no passkeys: this app's origin must stay refused.
          {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: { namespace: "android_app", package_name: "sh.jive.other", sha256_cert_fingerprints: [Array.from({ length: 32 }, () => "AB").join(":")] },
          },
        ]);
      }
      if (url.pathname === "/--/api/v2/push/send" && request.method === "POST") {
        const messages = await request.json() as Array<PushMessage>;
        pushed.push(...messages);
        return Response.json({
          data: messages.map((message) => uninstalled.has(message.to)
            ? { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }
            : { status: "ok", id: crypto.randomUUID() }),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const fakeOrigin = `http://127.0.0.1:${fakes.port}`;
  await initLocalDeployment({
    GITHUB_ACTIONS_JWKS: (await generateGithubActionsJwks()).jwks,
    WEBSITE_DOMAIN: "jive.sh",
    ASSET_LINKS_URL: `${fakeOrigin}/.well-known/assetlinks.json`,
    EXPO_PUSH_URL: `${fakeOrigin}/--/api/v2/push/send`,
  });
  devServer = await startDevServer();
  client = new ConvexHttpClient(devServer.url);
}, TIMEOUT);

afterAll(async () => {
  await devServer?.stop();
  fakes?.stop(true);
});

async function signIn(passkey: SoftwarePasskey, input: { readonly origin?: string; readonly signInRequestId?: string } = {}) {
  const { options } = await client.action(api.auth.signInOptions, {});
  const response = await passkey.signIn(options, input.origin);
  return await client.action(api.auth.signIn, {
    challenge: options.challenge,
    response,
    ...(input.signInRequestId === undefined ? {} : { signInRequestId: input.signInRequestId }),
  });
}

async function refusal(call: Promise<unknown>): Promise<string> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ConvexError);
  return String((error as ConvexError<string>).data);
}

const expoPushToken = () => `ExponentPushToken[${crypto.randomUUID().replaceAll("-", "")}]`;

/** Waits for the scheduled push of `requestId` to reach the fake push service. */
async function pushesOf(requestId: string, count: number): Promise<ReadonlyArray<PushMessage>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const matching = pushed.filter((message) => message.data.requestId === requestId);
    if (matching.length >= count) return matching;
    await Bun.sleep(100);
  }
  throw new Error(`push of ${requestId} never arrived; pushed: ${JSON.stringify(pushed)}`);
}

describe("a passkey from the Jive Android app", () => {
  test("signs in with the app's origin, which jive.sh's asset links grant passkeys to", async () => {
    const passkey = await createSoftwarePasskey("jive.sh");
    const registered = await registerAccount(client, passkey);
    const onPhone = await signIn(passkey, { origin: APP_ORIGIN });
    expect(onPhone.username).toBe(registered.username);
  }, TIMEOUT);

  test("an app the asset links grant only App Links, not passkeys, is refused", async () => {
    const passkey = await createSoftwarePasskey("jive.sh");
    await registerAccount(client, passkey);
    expect(await refusal(signIn(passkey, { origin: OTHER_APP_ORIGIN }))).toContain("could not be verified");
  }, TIMEOUT);
});

describe("phone approval of a program's sign-in", () => {
  test("a request opened with the account's last session token is pushed to its phone, and the phone's passkey approves it", async () => {
    pushed = [];
    const passkey = await createSoftwarePasskey("jive.sh");
    const desktop = await registerAccount(client, passkey);
    const phone = await signIn(passkey, { origin: APP_ORIGIN });
    const token = expoPushToken();
    await client.mutation(api.approvalDevices.enable, { sessionToken: phone.sessionToken, expoPushToken: token, label: "Pixel 9" });
    expect(await client.query(api.approvalDevices.list, { sessionToken: desktop.sessionToken }))
      .toMatchObject([{ expoPushToken: token, label: "Pixel 9" }]);

    // The CLI's previous session, here the desktop's: what `jive login` keeps on disk after it expires.
    const request = await client.action(api.signInRequests.open, { previousSessionToken: desktop.sessionToken });
    expect(request.approvalDevices).toBe(1);
    const [push] = await pushesOf(request.requestId, 1);
    expect(push).toMatchObject({
      to: token,
      data: { kind: "signInRequest", requestId: request.requestId },
      priority: "high",
      channelId: "sign-in-requests",
    });
    expect(push!.body).toContain(desktop.username);
    expect(push!.ttl).toBeGreaterThan(500);
    expect(await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret }))
      .toEqual({ status: "pending" });

    // Tapping the notification: the app's passkey ceremony, carrying the request.
    await signIn(passkey, { origin: APP_ORIGIN, signInRequestId: push!.data.requestId });
    const claimed = await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret });
    expect(claimed.status).toBe("approved");
    if (claimed.status !== "approved") throw new Error("unreachable");
    expect(await client.query(api.accounts.me, { sessionToken: claimed.sessionToken })).toMatchObject({ username: desktop.username });
  }, TIMEOUT);

  test("no previous session, an unknown one, or a signed-out one pushes to nobody", async () => {
    pushed = [];
    const passkey = await createSoftwarePasskey("jive.sh");
    const desktop = await registerAccount(client, passkey);
    await client.mutation(api.approvalDevices.enable, { sessionToken: desktop.sessionToken, expoPushToken: expoPushToken(), label: "Phone" });

    expect((await client.action(api.signInRequests.open, {})).approvalDevices).toBe(0);
    expect((await client.action(api.signInRequests.open, { previousSessionToken: "jive_unknown" })).approvalDevices).toBe(0);
    const signedOut = await signIn(passkey);
    await client.mutation(api.sessions.signOut, { sessionToken: signedOut.sessionToken });
    expect((await client.action(api.signInRequests.open, { previousSessionToken: signedOut.sessionToken })).approvalDevices).toBe(0);

    await Bun.sleep(1500);
    expect(pushed).toEqual([]);
  }, TIMEOUT);

  test("a phone Expo reports as no longer registered is forgotten", async () => {
    pushed = [];
    const passkey = await createSoftwarePasskey("jive.sh");
    const desktop = await registerAccount(client, passkey);
    const kept = expoPushToken();
    const gone = expoPushToken();
    uninstalled.add(gone);
    await client.mutation(api.approvalDevices.enable, { sessionToken: desktop.sessionToken, expoPushToken: kept, label: "Kept" });
    await client.mutation(api.approvalDevices.enable, { sessionToken: desktop.sessionToken, expoPushToken: gone, label: "Uninstalled" });

    const request = await client.action(api.signInRequests.open, { previousSessionToken: desktop.sessionToken });
    expect(request.approvalDevices).toBe(2);
    await pushesOf(request.requestId, 2);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const devices = await client.query(api.approvalDevices.list, { sessionToken: desktop.sessionToken });
      if (devices?.length === 1) break;
      await Bun.sleep(100);
    }
    expect(await client.query(api.approvalDevices.list, { sessionToken: desktop.sessionToken })).toMatchObject([{ expoPushToken: kept }]);
  }, TIMEOUT);

  test("enabling needs a live session and an Expo push token; disabling leaves other accounts' phones alone", async () => {
    const owner = await registerAccount(client, await createSoftwarePasskey("jive.sh"));
    const stranger = await registerAccount(client, await createSoftwarePasskey("jive.sh"));
    const token = expoPushToken();
    expect(await refusal(client.mutation(api.approvalDevices.enable, { sessionToken: "jive_unknown", expoPushToken: token, label: "Phone" })))
      .toContain("Sign in again");
    expect(await refusal(client.mutation(api.approvalDevices.enable, { sessionToken: owner.sessionToken, expoPushToken: "https://evil.example/push", label: "Phone" })))
      .toContain("not an Expo push token");

    await client.mutation(api.approvalDevices.enable, { sessionToken: owner.sessionToken, expoPushToken: token, label: "Phone" });
    await client.mutation(api.approvalDevices.disable, { sessionToken: stranger.sessionToken, expoPushToken: token });
    expect(await client.query(api.approvalDevices.list, { sessionToken: owner.sessionToken })).toHaveLength(1);
    await client.mutation(api.approvalDevices.disable, { sessionToken: owner.sessionToken, expoPushToken: token });
    expect(await client.query(api.approvalDevices.list, { sessionToken: owner.sessionToken })).toEqual([]);
    expect(await client.query(api.approvalDevices.list, { sessionToken: "jive_unknown" })).toBeNull();
  }, TIMEOUT);
});

describe("adding a phone whose platform does not sync the account's passkey", () => {
  async function addPasskey(sessionToken: string, passkey: SoftwarePasskey, origin: string) {
    const { options } = await client.action(api.auth.addPasskeyOptions, { sessionToken });
    const response = await passkey.register(options, origin);
    await client.action(api.auth.addPasskey, { sessionToken, challenge: options.challenge, response });
  }

  test("the desktop approves a request whose claim the phone redeems, and the phone adds a passkey it then signs in with", async () => {
    const desktopPasskey = await createSoftwarePasskey("jive.sh");
    const desktop = await registerAccount(client, desktopPasskey);

    // "Add a phone" on the website: a request the desktop's passkey approves, whose claim secret the phone scans.
    const request = await client.action(api.signInRequests.open, {});
    await signIn(desktopPasskey, { signInRequestId: request.requestId });
    const claimed = await client.action(api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret });
    if (claimed.status !== "approved") throw new Error(`claim answered ${claimed.status}`);

    const phonePasskey = await createSoftwarePasskey("jive.sh");
    await addPasskey(claimed.sessionToken, phonePasskey, APP_ORIGIN);
    const me = await client.query(api.accounts.me, { sessionToken: desktop.sessionToken });
    expect(me?.passkeys).toHaveLength(2);
    expect((await signIn(phonePasskey, { origin: APP_ORIGIN })).username).toBe(desktop.username);
  }, TIMEOUT);

  test("options issued to one account cannot be spent by another account's session, and an ended session gets none", async () => {
    const owner = await registerAccount(client, await createSoftwarePasskey("jive.sh"));
    const stranger = await registerAccount(client, await createSoftwarePasskey("jive.sh"));
    const { options } = await client.action(api.auth.addPasskeyOptions, { sessionToken: owner.sessionToken });
    const response = await (await createSoftwarePasskey("jive.sh")).register(options, APP_ORIGIN);
    expect(await refusal(client.action(api.auth.addPasskey, { sessionToken: stranger.sessionToken, challenge: options.challenge, response })))
      .toContain("Sign in again");
    expect(await client.query(api.accounts.me, { sessionToken: owner.sessionToken })).toMatchObject({ passkeys: [{}] });
    expect(await refusal(client.action(api.auth.addPasskeyOptions, { sessionToken: "jive_unknown" }))).toContain("Sign in again");
  }, TIMEOUT);

  test("the new passkey carries the account's own user handle and excludes its existing passkeys", async () => {
    const passkey = await createSoftwarePasskey("jive.sh");
    const opened = await registerAccount(client, passkey);
    const { options: registration } = await client.action(api.auth.registrationOptions, {});
    const { options } = await client.action(api.auth.addPasskeyOptions, { sessionToken: opened.sessionToken });
    expect(options.user.name).toBe(opened.username);
    expect(options.user.id).not.toBe(registration.user.id);
    expect(options.excludeCredentials).toEqual([expect.objectContaining({ id: passkey.credentialId })]);
  }, TIMEOUT);
});
