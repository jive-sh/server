import { Effect, Option, Schema, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { CeremonyFailed, type RelyingParty } from "./webAuthn";

/**
 * Which origins a passkey ceremony may come from. A browser on the website answers with the website's origin. An
 * Android app answers with `android:apk-key-hash:<SHA-256 of its signing certificate, base64url, no padding>`
 * (https://developer.android.com/identity/passkeys/create-passkeys), and Credential Manager hands an app the
 * website's passkeys only when the website's `/.well-known/assetlinks.json` grants that app
 * `delegate_permission/common.get_login_creds`. So the website's own asset links are the list of apps allowed here:
 * one source, which the app's deploy writes from the signing keys EAS holds.
 */

const ANDROID_ORIGIN_PREFIX = "android:apk-key-hash:";
const GET_LOGIN_CREDS = "delegate_permission/common.get_login_creds";

const AssetLinks = Schema.Array(Schema.Struct({
  relation: Schema.Array(Schema.String),
  target: Schema.Struct({
    namespace: Schema.String,
    sha256_cert_fingerprints: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
}));

const ClientData = Schema.fromJsonString(Schema.Struct({ origin: Schema.String }));

/** `AA:BB:…` (hex) becomes the base64url, unpadded, that follows `android:apk-key-hash:`. */
export function androidOriginOfFingerprint(fingerprint: string): string {
  const bytes = Uint8Array.from(fingerprint.split(":").map((pair) => Number.parseInt(pair, 16)));
  return `${ANDROID_ORIGIN_PREFIX}${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

/** The origin the authenticator signed over, read from the response's `clientDataJSON`; empty when unreadable. */
function claimedOrigin(response: unknown): string {
  const clientDataJSON = (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (typeof clientDataJSON !== "string") return "";
  let json: string;
  try {
    json = atob(clientDataJSON.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    // Not base64: the verifier refuses the response anyway.
    return "";
  }
  const decoded = Schema.decodeUnknownOption(ClientData)(json);
  return Option.isSome(decoded) ? decoded.value.origin : "";
}

/** The Android app origins the website's asset links grant its passkeys to. */
function androidOrigins(relyingParty: RelyingParty): Effect.Effect<ReadonlyArray<string>, CeremonyFailed> {
  // Tests point it at a fake website; production reads the website's own file.
  const url = process.env.ASSET_LINKS_URL ?? `${relyingParty.origin}/.well-known/assetlinks.json`;
  return pipe(
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const response = yield* client.get(url);
      return yield* HttpClientResponse.schemaBodyJson(AssetLinks)(response);
    }),
    Effect.map((statements) => statements
      .filter((statement) => statement.target.namespace === "android_app" && statement.relation.includes(GET_LOGIN_CREDS))
      .flatMap((statement) => statement.target.sha256_cert_fingerprints ?? [])
      .map(androidOriginOfFingerprint)),
    Effect.mapError(() => new CeremonyFailed({ message: `The passkey came from an Android app, and ${url} could not be read to check it.` })),
    Effect.provide(FetchHttpClient.layer),
  );
}

/**
 * The origins a ceremony's response may carry: the website's, plus, only when the response claims an Android app
 * origin, the apps the website's asset links allow (so a browser ceremony fetches nothing).
 */
export function allowedOrigins(input: { readonly relyingParty: RelyingParty; readonly response: unknown }): Effect.Effect<ReadonlyArray<string>, CeremonyFailed> {
  if (!claimedOrigin(input.response).startsWith(ANDROID_ORIGIN_PREFIX)) return Effect.succeed([input.relyingParty.origin]);
  return Effect.map(androidOrigins(input.relyingParty), (apps) => [input.relyingParty.origin, ...apps]);
}
