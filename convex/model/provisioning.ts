import { Context, Data, Effect, Option, pipe } from "effect";
import type { PipelineSession } from "./pipelineSessions";
import { planPublisher, type ListedPublisher, type PublisherClaims } from "./publisherPlan";

/**
 * `packages.provision` (design doc §3): make a registry package ready for the calling deploy job to publish by
 * trusted publishing. Idempotent, and run by every deploy right before it publishes, so each step reads the
 * registry before it writes, and a provisioning that failed is redone by the next deploy.
 */

/** Provisioning is not allowed, with a reason the deploy log shows. */
export class ProvisionRefused extends Data.TaggedError("ProvisionRefused")<{ readonly reason: string }> {}

/** The npm account an organization connected: a token from that person's npm login. */
export interface NpmAccount {
  readonly token: string;
}

/**
 * npm wants its second factor before a write: a person answers it on `pageUrl`, npm's own page. The connector never
 * answers it, and nothing here passes a person's answer back yet, so provisioning refuses with this page.
 */
export class SecondFactorRequired extends Data.TaggedError("SecondFactorRequired")<{
  readonly operation: string;
  readonly pageUrl: string;
}> {}

export interface PackageRecord {
  readonly codeRepositoryId: string;
  readonly trustedPublishers: ReadonlyArray<{ readonly environment: string; readonly registeredAt: number }>;
}

/** Jive's own records of organizations, code repositories, connections and packages. */
export interface IProvisioningRecords {
  findPackage(packageName: string): Effect.Effect<Option.Option<PackageRecord>>;
  /** The organization's npm account, unsealed; none when it has not connected one. */
  npmAccount(organizationId: string): Effect.Effect<Option.Option<NpmAccount>, Error>;
  /** Takes the package's claim; none while another provisioning holds an unexpired one. */
  claim(packageName: string): Effect.Effect<Option.Option<string>>;
  release(input: { readonly packageName: string; readonly holder: string }): Effect.Effect<void>;
  /** Binds the package to its code repository, and records a publisher Jive registered just now. */
  recordProvisioned(input: {
    readonly packageName: string;
    readonly codeRepositoryId: string;
    readonly registeredPublisherFor: Option.Option<string>;
  }): Effect.Effect<void>;
}
export class ProvisioningRecords extends Context.Service<ProvisioningRecords, IProvisioningRecords>()("ProvisioningRecords") {}

/**
 * The organization's package-registry connector (jive-resource-connector-package-registry-npm's functions). A write
 * npm guards with its second factor fails with `SecondFactorRequired`.
 */
export interface IRegistryConnector {
  createPlaceholder(input: { readonly packageName: string; readonly account: NpmAccount }): Effect.Effect<
    { readonly status: "created"; readonly version: string } | { readonly status: "alreadyExists" } | { readonly status: "maintainedByAnotherAccount" },
    SecondFactorRequired | Error
  >;
  listTrustedPublishers(input: { readonly packageName: string; readonly account: NpmAccount }): Effect.Effect<ReadonlyArray<ListedPublisher>, Error>;
  registerTrustedPublisher(input: { readonly packageName: string; readonly publisher: PublisherClaims; readonly account: NpmAccount }): Effect.Effect<
    void,
    SecondFactorRequired | Error
  >;
  removeTrustedPublisher(input: { readonly packageName: string; readonly id: string; readonly account: NpmAccount }): Effect.Effect<
    void,
    SecondFactorRequired | Error
  >;
}
export class RegistryConnector extends Context.Service<RegistryConnector, IRegistryConnector>()("RegistryConnector") {}

export type ProvisionOutcome = { readonly status: "ready" } | { readonly status: "inProgress" };

/**
 * Checks the package is bound to no code repository but the pipeline's, takes the package's claim (or answers
 * `inProgress`), and through the organization's npm connection creates the package if missing and makes sure a
 * publisher for the pipeline's workflow and environment can publish, replacing one npm may have expired. The claim
 * is released however this ends.
 */
export function provisionPackage(input: {
  readonly pipeline: PipelineSession;
  readonly packageName: string;
  readonly now: number;
}): Effect.Effect<ProvisionOutcome, ProvisionRefused | Error, ProvisioningRecords | RegistryConnector> {
  return Effect.gen(function* () {
    const records = yield* ProvisioningRecords;
    const { pipeline, packageName } = input;

    const maybePackage = yield* records.findPackage(packageName);
    if (Option.isSome(maybePackage) && maybePackage.value.codeRepositoryId !== pipeline.codeRepositoryId) {
      return yield* new ProvisionRefused({ reason: `${packageName} is provisioned for another code repository` });
    }

    const maybeHolder = yield* records.claim(packageName);
    if (Option.isNone(maybeHolder)) return { status: "inProgress" } as const;
    return yield* pipe(
      provisionClaimed({ ...input, maybePackage }),
      Effect.catchTag("SecondFactorRequired", ({ operation, pageUrl }) => Effect.fail(new ProvisionRefused({
        reason: `npm asked for its second factor to ${operation}; a person answers it on ${pageUrl}, and Jive cannot pass that answer back to npm yet`,
      }))),
      Effect.ensuring(records.release({ packageName, holder: maybeHolder.value })),
    );
  });
}

function provisionClaimed(input: {
  readonly pipeline: PipelineSession;
  readonly packageName: string;
  readonly now: number;
  readonly maybePackage: Option.Option<PackageRecord>;
}): Effect.Effect<ProvisionOutcome, ProvisionRefused | SecondFactorRequired | Error, ProvisioningRecords | RegistryConnector> {
  return Effect.gen(function* () {
    const records = yield* ProvisioningRecords;
    const connector = yield* RegistryConnector;
    const { pipeline, packageName, maybePackage } = input;

    const maybeAccount = yield* records.npmAccount(pipeline.organizationId);
    if (Option.isNone(maybeAccount)) {
      return yield* new ProvisionRefused({ reason: "the repository's organization has not connected an npm account to Jive" });
    }
    const account = maybeAccount.value;

    const placeholder = yield* connector.createPlaceholder({ packageName, account });
    if (placeholder.status === "maintainedByAnotherAccount") {
      return yield* new ProvisionRefused({ reason: `${packageName} exists on npm and the organization's npm account does not maintain it` });
    }

    const wanted: PublisherClaims = {
      provider: "github",
      repository: pipeline.repository,
      workflowFile: pipeline.workflowFile,
      environment: pipeline.environment,
    };
    const maybeRegisteredAt = pipe(
      maybePackage,
      Option.flatMap((record) => Option.fromUndefinedOr(record.trustedPublishers.find((publisher) => publisher.environment === pipeline.environment))),
      Option.map((publisher) => publisher.registeredAt),
    );
    const plan = planPublisher({
      listed: yield* connector.listTrustedPublishers({ packageName, account }),
      wanted,
      maybeRegisteredAt,
      now: input.now,
    });
    if (plan.action === "register") {
      for (const id of plan.removeIds) yield* connector.removeTrustedPublisher({ packageName, id, account });
      yield* connector.registerTrustedPublisher({ packageName, publisher: wanted, account });
    }
    yield* records.recordProvisioned({
      packageName,
      codeRepositoryId: pipeline.codeRepositoryId,
      registeredPublisherFor: plan.action === "register" ? Option.some(pipeline.environment) : Option.none(),
    });
    return { status: "ready" } as const;
  });
}
