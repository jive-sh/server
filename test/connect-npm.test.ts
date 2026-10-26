import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Effect, Exit } from "effect";
import { parseAuthenticatorSecret } from "../scripts/connect-npm/authenticatorSecret";
import { HiddenPrompts } from "../scripts/connect-npm/hiddenPrompt";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function parse(input: string) {
  return Effect.runPromiseExit(parseAuthenticatorSecret(input));
}

describe("parseAuthenticatorSecret", () => {
  test("takes base32 as shown under a QR code, in any case and grouping", async () => {
    expect(await parse(SECRET)).toEqual(Exit.succeed(SECRET));
    expect(await parse("gezd gnbv gy3t qojq gezd gnbv gy3t qojq ")).toEqual(Exit.succeed(SECRET));
    expect(await parse(`${SECRET}====`)).toEqual(Exit.succeed(SECRET));
  });

  test("takes the otpauth URL a QR code encodes", async () => {
    expect(await parse(`otpauth://totp/npm:chaine.dance?secret=${SECRET.toLowerCase()}&issuer=npm`)).toEqual(Exit.succeed(SECRET));
    expect(await parse(`otpauth://totp/npm?secret=${SECRET}&algorithm=SHA1&digits=6&period=30`)).toEqual(Exit.succeed(SECRET));
  });

  test("refuses what the connector could not answer with, without echoing it", async () => {
    for (const [input, reason] of [
      [`otpauth://hotp/npm?secret=${SECRET}`, "not totp"],
      [`otpauth://totp/npm?secret=${SECRET}&algorithm=SHA256`, "only SHA1"],
      [`otpauth://totp/npm?secret=${SECRET}&digits=8`, "only 6"],
      [`otpauth://totp/npm?secret=${SECRET}&period=60`, "only 30"],
      ["otpauth://totp/npm?issuer=npm", "no secret parameter"],
      ["NOT-BASE32-189", "outside A-Z and 2-7"],
      ["   ", "empty"],
    ] as const) {
      const exit = await parse(input);
      expect(Exit.isFailure(exit), input).toBe(true);
      expect(JSON.stringify(exit)).toContain(reason);
      if (input.includes(SECRET)) expect(JSON.stringify(exit)).not.toContain(SECRET);
    }
  });
});

describe("HiddenPrompts from a pipe", () => {
  test("gives each prompt its own line when several arrive at once, and fails once input ends", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const prompts = new HiddenPrompts(stdin);
    (stdin as unknown as PassThrough).end("first\r\nsecond\nthird");
    expect(await Effect.runPromise(prompts.ask(""))).toBe("first");
    expect(await Effect.runPromise(prompts.ask(""))).toBe("second");
    expect(await Effect.runPromise(prompts.ask(""))).toBe("third");
    expect(Exit.isFailure(await Effect.runPromiseExit(prompts.ask("")))).toBe(true);
  });
});
