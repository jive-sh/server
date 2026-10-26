import { Data, Effect } from "effect";

/** The input is neither a base32 secret nor an `otpauth://totp/` URL this connector can use. Never carries the input. */
export class InvalidAuthenticatorSecret extends Data.TaggedError("InvalidAuthenticatorSecret")<{ readonly reason: string }> {
  override get message(): string {
    return `that is not a usable authenticator setup secret: ${this.reason}`;
  }
}

const BASE32 = /^[A-Z2-7]+$/;

/** Spaces, `-` and `=` padding removed, uppercased: the form npm's setup page shows and the connector decodes. */
function normalizeBase32(text: string): Effect.Effect<string, InvalidAuthenticatorSecret> {
  const normalized = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (normalized.length === 0) return Effect.fail(new InvalidAuthenticatorSecret({ reason: "it is empty" }));
  if (!BASE32.test(normalized)) return Effect.fail(new InvalidAuthenticatorSecret({ reason: "it has characters outside A-Z and 2-7" }));
  return Effect.succeed(normalized);
}

/**
 * Reads the secret npm's two-factor setup gives, either as the base32 text shown under the QR code or as the whole
 * `otpauth://totp/...?secret=...` URL the QR code encodes (Google Authenticator's Key URI format). The connector
 * computes HMAC-SHA-1, 6-digit, 30-second codes, so a URL asking for another algorithm, digit count or period is
 * refused rather than stored to fail later.
 */
export function parseAuthenticatorSecret(input: string): Effect.Effect<string, InvalidAuthenticatorSecret> {
  return Effect.suspend(() => {
    const text = input.trim();
    if (!/^otpauth:/i.test(text)) return normalizeBase32(text);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return Effect.fail(new InvalidAuthenticatorSecret({ reason: "the otpauth URL does not parse" }));
    }
    if (url.host.toLowerCase() !== "totp") {
      return Effect.fail(new InvalidAuthenticatorSecret({ reason: `the otpauth URL is for ${url.host || "nothing"}, not totp` }));
    }
    const algorithm = url.searchParams.get("algorithm");
    if (algorithm !== null && algorithm.toUpperCase() !== "SHA1") {
      return Effect.fail(new InvalidAuthenticatorSecret({ reason: `the URL asks for ${algorithm}; only SHA1 is supported` }));
    }
    const digits = url.searchParams.get("digits");
    if (digits !== null && digits !== "6") return Effect.fail(new InvalidAuthenticatorSecret({ reason: `the URL asks for ${digits} digits; only 6 are supported` }));
    const period = url.searchParams.get("period");
    if (period !== null && period !== "30") return Effect.fail(new InvalidAuthenticatorSecret({ reason: `the URL asks for a ${period}-second period; only 30 is supported` }));
    const secret = url.searchParams.get("secret");
    if (secret === null) return Effect.fail(new InvalidAuthenticatorSecret({ reason: "the otpauth URL has no secret parameter" }));
    return normalizeBase32(secret);
  });
}
