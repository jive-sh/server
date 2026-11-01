import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Effect, Exit } from "effect";
import { HiddenPrompts } from "../scripts/connect-npm/hiddenPrompt";

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
