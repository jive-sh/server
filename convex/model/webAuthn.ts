import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Data, Effect } from "effect";
import { fromBase64Url, toBase64Url } from "./tokens";

/**
 * Passkey ceremonies through `@simplewebauthn/server` (Web Crypto only), run in actions. The relying party is
 * the website's registrable domain, `jive.sh` in production, so the passkeys skill-sync registered on
 * `*.jive.sh` pages work here too. The accepted origins are the website's own and the Android apps its asset links
 * grant its passkeys to (`androidApps.ts`).
 *
 * Every passkey is discoverable (`residentKey: "required"`), so signing in needs no username, and user
 * verification is required, so a sign-in proves a person, not only a device.
 */

/** `WEBSITE_DOMAIN` is unset, so no ceremony can say which relying party it is for. */
export class WebsiteDomainMissing extends Data.TaggedError("WebsiteDomainMissing")<{}> {
  override get message(): string {
    return "WEBSITE_DOMAIN is not set on this deployment";
  }
}

/** The browser's response did not verify. `message` is safe to show the person. */
export class CeremonyFailed extends Data.TaggedError("CeremonyFailed")<{ readonly message: string }> {}

export interface RelyingParty {
  readonly id: string;
  readonly origin: string;
}

/** The relying party for `WEBSITE_DOMAIN`: its host without a port, and its origin (http only on localhost). */
export function relyingPartyOf(maybeWebsiteDomain: string | undefined): Effect.Effect<RelyingParty, WebsiteDomainMissing> {
  if (maybeWebsiteDomain === undefined || maybeWebsiteDomain === "") return Effect.fail(new WebsiteDomainMissing());
  const local = maybeWebsiteDomain === "localhost" || maybeWebsiteDomain.startsWith("localhost:") || maybeWebsiteDomain.startsWith("127.0.0.1");
  return Effect.succeed({
    id: maybeWebsiteDomain.split(":")[0] as string,
    origin: `${local ? "http" : "https"}://${maybeWebsiteDomain}`,
  });
}

const failed = (ceremony: string) => (cause: unknown) =>
  new CeremonyFailed({ message: `The passkey ${ceremony} could not be verified: ${cause instanceof Error ? cause.message : String(cause)}` });

/**
 * Options for creating a passkey. The challenge is passed as bytes: given a string, the library would
 * base64url-encode its UTF-8, and the browser would sign a challenge other than the one stored.
 */
export function registrationOptions(input: {
  readonly relyingParty: RelyingParty;
  readonly challenge: string;
  readonly webAuthnUserId: string;
  readonly username: string;
  /** Passkeys the account already has, so an authenticator holding one of them does not make a second. */
  readonly excludeCredentialIds?: ReadonlyArray<string>;
}): Effect.Effect<PublicKeyCredentialCreationOptionsJSON> {
  return Effect.map(
    Effect.promise(() => generateRegistrationOptions({
      rpID: input.relyingParty.id,
      rpName: "Jive",
      userName: input.username,
      userID: new TextEncoder().encode(input.webAuthnUserId),
      challenge: fromBase64Url(input.challenge),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: (input.excludeCredentialIds ?? []).map((id) => ({ id })),
    })),
    // Undefined fields (`extensions`) are refused by Convex's return validation; JSON drops them anyway.
    (options) => JSON.parse(JSON.stringify(options)) as PublicKeyCredentialCreationOptionsJSON,
  );
}

export function verifyRegistration(input: {
  readonly relyingParty: RelyingParty;
  /** The website's origin, plus any app origins `allowedOrigins` (androidApps.ts) admits for this response. */
  readonly expectedOrigins: ReadonlyArray<string>;
  readonly challenge: string;
  readonly response: RegistrationResponseJSON;
}): Effect.Effect<{ readonly credentialId: string; readonly publicKey: string }, CeremonyFailed> {
  return Effect.gen(function* () {
    const verification = yield* Effect.tryPromise({
      try: () => verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: input.challenge,
        expectedOrigin: [...input.expectedOrigins],
        expectedRPID: input.relyingParty.id,
        requireUserVerification: true,
      }),
      catch: failed("registration"),
    });
    if (!verification.verified) return yield* new CeremonyFailed({ message: "The passkey could not be verified" });
    const { credential } = verification.registrationInfo;
    return { credentialId: credential.id, publicKey: toBase64Url(credential.publicKey) };
  });
}

/** Options for signing in. No credential list: the authenticator offers whatever passkeys it holds for `jive.sh`. */
export function authenticationOptions(input: {
  readonly relyingParty: RelyingParty;
  readonly challenge: string;
}): Effect.Effect<PublicKeyCredentialRequestOptionsJSON> {
  return Effect.map(
    Effect.promise(() => generateAuthenticationOptions({
      rpID: input.relyingParty.id,
      challenge: fromBase64Url(input.challenge),
      allowCredentials: [],
      userVerification: "required",
    })),
    // The library sets `extensions: undefined`, which Convex's return validation refuses; JSON drops it anyway.
    (options) => JSON.parse(JSON.stringify(options)) as PublicKeyCredentialRequestOptionsJSON,
  );
}

export function verifyAuthentication(input: {
  readonly relyingParty: RelyingParty;
  readonly expectedOrigins: ReadonlyArray<string>;
  readonly challenge: string;
  readonly response: AuthenticationResponseJSON;
  readonly passkey: { readonly credentialId: string; readonly publicKey: string };
}): Effect.Effect<void, CeremonyFailed> {
  return Effect.gen(function* () {
    const verification = yield* Effect.tryPromise({
      try: () => verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: input.challenge,
        expectedOrigin: [...input.expectedOrigins],
        expectedRPID: input.relyingParty.id,
        requireUserVerification: true,
        // Always zero: no counter is kept (see `passkeys` in the schema).
        credential: { id: input.passkey.credentialId, publicKey: fromBase64Url(input.passkey.publicKey), counter: 0 },
      }),
      catch: failed("sign-in"),
    });
    if (!verification.verified) return yield* new CeremonyFailed({ message: "The passkey could not be verified" });
  });
}
