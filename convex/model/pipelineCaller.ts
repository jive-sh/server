import { Effect, Option, Schema, SchemaIssue, pipe } from "effect";
import { GITHUB_ACTIONS_ISSUER } from "./githubActions";
import { ProvisionRefused } from "./provisioning";

/**
 * The GitHub Actions job calling Jive, read from its verified ID token. Convex checked the signature, issuer and
 * audience before the function ran; this decides whether the job may provision (design doc §6, Alex's direction:
 * "the ID token includes things like the environment... some kind of protected branches setup").
 */
export interface PipelineCaller {
  /** GitHub's immutable ids, which is how a registered code repository is found; names can be recycled. */
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  /** The repository's current owner and name, which npm's trusted publisher names. */
  readonly repository: { readonly owner: string; readonly name: string };
  /** The GitHub Actions environment the job runs in, which its trusted publisher is registered for. */
  readonly environment: string;
  /** The calling workflow's file name, e.g. "pipeline.yml" (`workflow_ref` names the caller of a reusable workflow). */
  readonly workflowFile: string;
}

/** The only workflow file Jive provisions for: npm matches the calling workflow, and every Jive package's is this. */
export const PIPELINE_WORKFLOW_FILE = "pipeline.yml";

/**
 * The claims read from the identity Convex hands a function: `issuer` is the token's `iss`, and "any additional
 * fields are custom claims" (https://docs.convex.dev/api/interfaces/server.UserIdentity). GitHub's claims are
 * listed at https://docs.github.com/en/actions/reference/security/oidc#custom-claims-provided-by-github.
 */
const GithubActionsClaims = Schema.Struct({
  issuer: Schema.Literal(GITHUB_ACTIONS_ISSUER),
  repository_id: Schema.String,
  repository_owner_id: Schema.String,
  repository: Schema.String,
  workflow_ref: Schema.String,
  event_name: Schema.String,
  runner_environment: Schema.String,
  // GitHub's documented example writes it as the string "true"; a JSON boolean is accepted too.
  ref_protected: Schema.Union([Schema.Literal("true"), Schema.Literal("false"), Schema.Boolean]),
  environment: Schema.optionalKey(Schema.String),
});

const formatIssue = SchemaIssue.makeFormatterDefault();

/** `owner/repo/.github/workflows/pipeline.yml@refs/heads/main` → `pipeline.yml`. */
function workflowFileOf(workflowRef: string): Option.Option<string> {
  const match = workflowRef.match(/^[^/]+\/[^/]+\/\.github\/workflows\/([^@/]+)@/);
  return match === null ? Option.none() : Option.some(match[1]!);
}

/**
 * Decodes the caller's identity and refuses a job that may not provision: one without an environment, on an
 * unprotected ref, from a pull request or anything but a push or a manual run, from a workflow other than
 * `pipeline.yml`, or on a self-hosted runner (npm refuses those trusted publishes anyway). Every reason names
 * what to change; none repeats the token.
 */
export function authorizePipelineCaller(identity: unknown): Effect.Effect<PipelineCaller, ProvisionRefused> {
  return Effect.gen(function* () {
    const claims = yield* pipe(
      Schema.decodeUnknownEffect(GithubActionsClaims)(identity),
      Effect.mapError((e) => new ProvisionRefused({
        reason: `the caller is not a GitHub Actions job Jive can identify: ${formatIssue(e.issue)}`,
      })),
    );
    const [owner, name, ...rest] = claims.repository.split("/");
    if (!owner || !name || rest.length > 0) {
      return yield* new ProvisionRefused({ reason: `the token's repository claim "${claims.repository}" is not owner/name` });
    }
    const maybeWorkflowFile = workflowFileOf(claims.workflow_ref);
    if (Option.isNone(maybeWorkflowFile) || maybeWorkflowFile.value !== PIPELINE_WORKFLOW_FILE) {
      return yield* new ProvisionRefused({
        reason: `only .github/workflows/${PIPELINE_WORKFLOW_FILE} may provision packages; this job runs ${claims.workflow_ref}`,
      });
    }
    if (claims.environment === undefined) {
      return yield* new ProvisionRefused({ reason: "the job runs in no GitHub Actions environment; a deploy job names the environment it publishes to" });
    }
    if (claims.event_name !== "push" && claims.event_name !== "workflow_dispatch") {
      return yield* new ProvisionRefused({ reason: `a ${claims.event_name} run may not provision; only push and workflow_dispatch may` });
    }
    if (claims.ref_protected !== true && claims.ref_protected !== "true") {
      return yield* new ProvisionRefused({ reason: "the job runs on an unprotected branch or tag; protect it on GitHub to let it provision" });
    }
    if (claims.runner_environment !== "github-hosted") {
      return yield* new ProvisionRefused({ reason: "the job runs on a self-hosted runner, which npm's trusted publishing refuses" });
    }
    return {
      repositoryId: claims.repository_id,
      repositoryOwnerId: claims.repository_owner_id,
      repository: { owner, name },
      environment: claims.environment,
      workflowFile: maybeWorkflowFile.value,
    };
  });
}
