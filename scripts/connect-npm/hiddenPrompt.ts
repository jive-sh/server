import { Data, Effect } from "effect";

export class PromptCancelled extends Data.TaggedError("PromptCancelled")<{}> {
  override get message(): string {
    return "cancelled";
  }
}

/**
 * Prompts that never echo what is typed. On a terminal, stdin is read in raw mode, so nothing typed or pasted is
 * shown or left in scrollback; Ctrl-C or Ctrl-D cancels. When stdin is not a terminal (a pipe, as in tests), each
 * prompt takes the next line. Input after a line's end is kept for the next prompt, since a pipe can deliver
 * several lines at once.
 */
export class HiddenPrompts {
  private pending = "";
  private ended = false;
  /** Re-checks the waiting prompt; set while one waits. */
  private recheck: (() => void) | undefined;

  constructor(private readonly stdin: NodeJS.ReadStream = process.stdin) {
    // Listened to for the object's whole life: a pipe can end while no prompt is waiting.
    stdin.once("end", () => {
      this.ended = true;
      this.recheck?.();
    });
  }

  /** Asks `question` on stderr and returns the line entered, without its line ending. */
  ask(question: string): Effect.Effect<string, PromptCancelled> {
    return Effect.callback<string, PromptCancelled>((resume) => {
      const { stdin } = this;
      const terminal = stdin.isTTY === true;
      // Raw mode before the prompt appears: anything typed in between would otherwise be echoed by the terminal.
      if (terminal) stdin.setRawMode(true);
      process.stderr.write(question);
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (terminal && (character === "\u007f" || character === "\b")) this.pending = this.pending.slice(0, -1);
          else this.pending += character;
        }
        takeLine();
      };
      const done = (outcome: Effect.Effect<string, PromptCancelled>) => {
        stdin.off("data", onData);
        this.recheck = undefined;
        if (terminal) stdin.setRawMode(false);
        stdin.pause();
        process.stderr.write("\n");
        resume(outcome);
      };
      /** Answers the prompt with one line, if a whole line has arrived or input has ended; true when answered. */
      const takeLine = (): boolean => {
        const characters = [...this.pending];
        for (const [index, character] of characters.entries()) {
          if (character === "\u0003" || character === "\u0004") {
            this.pending = "";
            done(Effect.fail(new PromptCancelled()));
            return true;
          }
          if (character === "\r" || character === "\n") {
            const rest = characters.slice(index + 1).join("");
            this.pending = character === "\r" && rest.startsWith("\n") ? rest.slice(1) : rest;
            done(Effect.succeed(characters.slice(0, index).join("")));
            return true;
          }
        }
        if (this.ended) {
          const line = this.pending;
          this.pending = "";
          done(line.length > 0 ? Effect.succeed(line) : Effect.fail(new PromptCancelled()));
          return true;
        }
        return false;
      };
      if (takeLine()) return;
      this.recheck = () => void takeLine();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      stdin.resume();
    });
  }
}
