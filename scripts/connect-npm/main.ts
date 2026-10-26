import { parseArgs } from "node:util";
import { Data, Effect, Schema, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { parseAuthenticatorSecret } from "./authenticatorSecret";
import { HiddenPrompts } from "./hiddenPrompt";

/**
 * `bun run connect-npm -- --deployment <name> --organization <name>`: stores an organization's npm account (its
 * token and authenticator-app secret) on a Jive server deployment, sealed, without either ever appearing on a
 * command line or in shell history.
 *
 * 1. Prompts for both without echoing them.
 * 2. Checks the token with npm's read-only `/-/whoami`. It never sends a one-time password to npm.
 * 3. Asks the deployment, through `convex run` (admin access, no secret in its arguments), for a single-use
 *    connection request.
 * 4. Sends the credential with that request to `connections:completeNpmConnection` in an HTTPS body.
 *
 * `--deployment` is any deployment `convex run --deployment` accepts; without it, the one this checkout is
 * configured for. `--npm-registry` exists for tests.
 */

class ConnectNpmFailed extends Data.TaggedError("ConnectNpmFailed")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason;
  }
}

const Whoami = Schema.Struct({ username: Schema.String });
const ConnectionRequest = Schema.fromJsonString(Schema.Struct({ requestId: Schema.String, deploymentUrl: Schema.String }));
const ActionAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success") }),
  Schema.Struct({ status: Schema.Literal("error"), errorMessage: Schema.String }),
]);

const { values: options } = parseArgs({
  options: {
    deployment: { type: "string" },
    organization: { type: "string" },
    "npm-registry": { type: "string", default: "https://registry.npmjs.org" },
  },
});

/** Runs the Convex CLI in this package; its arguments never include a secret. */
function convexRun(args: ReadonlyArray<string>): Effect.Effect<string, ConnectNpmFailed> {
  return Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["bunx", "convex", "run", ...args], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(stderr.trim().split("\n").slice(-3).join("\n"));
      return stdout;
    },
    catch: (cause) => new ConnectNpmFailed({ reason: `convex run ${args[0]} failed: ${cause instanceof Error ? cause.message : String(cause)}` }),
  });
}

const program = Effect.gen(function* () {
  const organization = options.organization;
  if (organization === undefined) return yield* new ConnectNpmFailed({ reason: "pass --organization <name>, the Jive organization the npm account belongs to" });
  const deploymentArgs = options.deployment === undefined ? [] : ["--deployment", options.deployment];
  const registry = options["npm-registry"].replace(/\/+$/, "");
  yield* Effect.logInfo(`Connecting an npm account to organization ${organization} on deployment ${options.deployment ?? "(this checkout's configured one)"}`);

  const prompts = new HiddenPrompts();
  const token = (yield* prompts.ask("npm access token (hidden): ")).trim();
  if (token === "") return yield* new ConnectNpmFailed({ reason: "no token entered" });
  const secret = yield* parseAuthenticatorSecret(yield* prompts.ask("Authenticator setup secret, or the otpauth:// URL (hidden): "));

  const client = yield* HttpClient.HttpClient;
  const whoami = yield* pipe(
    client.execute(pipe(HttpClientRequest.get(`${registry}/-/whoami`), HttpClientRequest.bearerToken(token))),
    Effect.mapError((e) => new ConnectNpmFailed({ reason: `could not reach ${registry}: ${e.message}` })),
  );
  if (whoami.status !== 200) {
    return yield* new ConnectNpmFailed({ reason: `npm refused the token (${registry}/-/whoami answered ${whoami.status}); nothing was stored` });
  }
  const { username } = yield* pipe(
    whoami.json,
    Effect.flatMap(Schema.decodeUnknownEffect(Whoami)),
    Effect.mapError(() => new ConnectNpmFailed({ reason: "npm's /-/whoami answer has no username; nothing was stored" })),
  );
  yield* Effect.logInfo(`The token belongs to npm user ${username}`);

  const request = yield* pipe(
    convexRun(["connections:openNpmConnectionRequest", JSON.stringify({ organizationName: organization }), ...deploymentArgs]),
    Effect.flatMap((stdout) => pipe(
      Schema.decodeUnknownEffect(ConnectionRequest)(stdout),
      Effect.mapError(() => new ConnectNpmFailed({ reason: `unexpected answer from openNpmConnectionRequest: ${stdout.slice(0, 200)}` })),
    )),
  );
  const answer = yield* pipe(
    client.execute(pipe(
      HttpClientRequest.post(`${request.deploymentUrl}/api/action`),
      HttpClientRequest.bodyJsonUnsafe({
        path: "connections:completeNpmConnection",
        args: { requestId: request.requestId, token, totpSecret: secret },
        format: "json",
      }),
    )),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(ActionAnswer)),
    Effect.mapError((e) => new ConnectNpmFailed({ reason: `could not store the connection at ${request.deploymentUrl}: ${e.message}` })),
  );
  if (answer.status === "error") return yield* new ConnectNpmFailed({ reason: `the deployment refused the connection: ${answer.errorMessage}` });
  yield* Effect.logInfo(`Stored npm user ${username}'s connection for organization ${organization}, sealed, at ${request.deploymentUrl}`);
});

const exitCode = await Effect.runPromise(pipe(
  program,
  Effect.match({
    onFailure: (error) => {
      process.stderr.write(`connect-npm: ${error.message}\n`);
      return 1;
    },
    onSuccess: () => 0,
  }),
  Effect.provide(FetchHttpClient.layer),
));
process.exit(exitCode);
