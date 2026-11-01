import { Effect, Result, Schema, SchemaIssue, pipe } from "effect";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { ProvisionResult, ResourceImplementation } from "./resourceKinds";

/**
 * jive-resource-connector-package-registry-npm, the `connector-package-registry` implementation installed here as
 * `packageRegistryNpm`. The organization's npm account comes from `accountKeys`, which holds its sealed token; the
 * connector stores no credential, so it is passed on every call.
 *
 * npm's second factor is answered by a person on npm's own page (`url`, npm's authUrl): npm accepts no assertion
 * posted without a browser, so the server never signs one. When the connector answers `personNeeded` with a
 * `resultUrl` (npm's doneUrl), this polls it briefly: once a person has finished the page it gives the one-time
 * password, and the call is repeated with it.
 */

const PackageInstance = Schema.Struct({ packageName: Schema.NonEmptyString });
const formatIssue = SchemaIssue.makeFormatterDefault();

/** How often, and for how long, npm's doneUrl is asked whether a person has finished its page. */
const RESULT_POLL_EVERY_MS = 1_000;
const RESULT_POLL_FOR_MS = 10_000;

/**
 * How many second-factor answers one provisioning uses at most: a new package can meet npm's second factor for its
 * placeholder, a publisher's removal and its registration, when npm doesn't let one answer cover the next writes.
 */
const MAX_SECOND_FACTOR_ANSWERS = 3;

/** npm's doneUrl answer once a person has finished its page. */
const DoneAnswer = Schema.Struct({ token: Schema.String });

/**
 * The one-time password npm's doneUrl gives once a person has finished npm's page, or null when no one has within
 * the poll window (202 means still waiting) or it answers anything else. The password is never logged.
 */
async function oneTimePasswordFrom(resultUrl: string): Promise<string | null> {
  const deadline = Date.now() + RESULT_POLL_FOR_MS;
  while (true) {
    const response = await fetch(resultUrl, { headers: { accept: "application/json" } });
    if (response.status === 200) {
      const decoded = await Effect.runPromise(Effect.result(Schema.decodeUnknownEffect(Schema.fromJsonString(DoneAnswer))(await response.text())));
      return Result.isSuccess(decoded) ? decoded.success.token : null;
    }
    if (response.status !== 202 || Date.now() + RESULT_POLL_EVERY_MS > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_EVERY_MS));
  }
}

export const packageRegistryNpm: ResourceImplementation = {
  packageName: "jive-resource-connector-package-registry-npm",
  async ensureInstance(ctx: ActionCtx, { instance, pipeline, organizationName }): Promise<ProvisionResult> {
    const decoded = await Effect.runPromise(Effect.result(pipe(Schema.decodeUnknownEffect(PackageInstance)(instance), Effect.mapError((e) => formatIssue(e.issue)))));
    if (Result.isFailure(decoded)) {
      return { status: "refused", reason: `a connector-package-registry instance is { packageName }: ${decoded.failure}` };
    }
    const account = await ctx.runAction(components.accountKeys.npmConnection.token, { organizationId: pipeline.organizationId });
    if (account === null) return { status: "refused", reason: `the organization ${organizationName} has not connected an npm account to Jive` };
    const args = {
      instance: { packageName: decoded.success.packageName },
      caller: {
        codeRepository: { id: pipeline.codeRepositoryId, owner: pipeline.repository.owner, name: pipeline.repository.name },
        environment: pipeline.environment,
        workflowFile: pipeline.workflowFile,
      },
      account,
    };

    let result = await ctx.runAction(components.packageRegistryNpm.resource.ensureInstance, args);
    let answered = false;
    for (let answers = 0; result.status === "personNeeded" && result.resultUrl !== undefined && answers < MAX_SECOND_FACTOR_ANSWERS; answers += 1) {
      const oneTimePassword = await oneTimePasswordFrom(result.resultUrl);
      if (oneTimePassword === null) break;
      answered = true;
      result = await ctx.runAction(components.packageRegistryNpm.resource.ensureInstance, { ...args, oneTimePassword });
    }
    if (result.status === "ready" && answered) {
      await ctx.runMutation(components.accountKeys.npmConnection.markRegistered, { organizationId: pipeline.organizationId });
    }
    // `provision` answers a person only the page; where npm hands the answer to a program stays inside the server.
    return result.status === "personNeeded" ? { status: "personNeeded", reason: result.reason, url: result.url } : result;
  },
};
