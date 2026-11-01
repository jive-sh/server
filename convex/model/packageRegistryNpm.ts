import { Effect, Result, Schema, SchemaIssue, pipe } from "effect";
import { components } from "../_generated/api";
import type { ProvisionResult, ResourceImplementation } from "./resourceKinds";

/**
 * jive-resource-connector-package-registry-npm, the `connector-package-registry` implementation installed here as
 * `packageRegistryNpm`. The organization's npm account comes from `accountKeys`, which holds its sealed token; the
 * connector stores no credential, so it is passed on every call.
 */

const PackageInstance = Schema.Struct({ packageName: Schema.NonEmptyString });
const formatIssue = SchemaIssue.makeFormatterDefault();

export const packageRegistryNpm: ResourceImplementation = {
  packageName: "jive-resource-connector-package-registry-npm",
  async ensureInstance(ctx, { instance, pipeline, organizationName }): Promise<ProvisionResult> {
    const decoded = await Effect.runPromise(Effect.result(pipe(Schema.decodeUnknownEffect(PackageInstance)(instance), Effect.mapError((e) => formatIssue(e.issue)))));
    if (Result.isFailure(decoded)) {
      return { status: "refused", reason: `a connector-package-registry instance is { packageName }: ${decoded.failure}` };
    }
    const account = await ctx.runAction(components.accountKeys.npmConnection.token, { organizationId: pipeline.organizationId });
    if (account === null) return { status: "refused", reason: `the organization ${organizationName} has not connected an npm account to Jive` };
    return await ctx.runAction(components.packageRegistryNpm.resource.ensureInstance, {
      instance: { packageName: decoded.success.packageName },
      caller: {
        codeRepository: { id: pipeline.codeRepositoryId, owner: pipeline.repository.owner, name: pipeline.repository.name },
        environment: pipeline.environment,
        workflowFile: pipeline.workflowFile,
      },
      account,
    });
  },
};
