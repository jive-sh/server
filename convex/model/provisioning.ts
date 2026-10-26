import { Context, Data, Effect, Option, pipe } from "effect";
import type { PipelineCaller } from "./pipelineCaller";
import { planPublisher, type ListedPublisher, type PublisherClaims } from "./publisherPlan";

/**
 * `packages.provision` (design doc §3): make a registry package ready for the calling deploy job to publish by
 * trusted publishing. Idempotent, and run by every deploy right before it publishes, so each step reads the
 * registry before it writes, and a provisioning that failed is redone by the next deploy.
 */

/** Provisioning is not allowed, with a reason the deploy log shows. */
export class ProvisionRefused extends Data.TaggedError("ProvisionRefused")<{ readonly reason: string }> {}

/** The npm account an organization connected: its token and its authenticator-app secret. */
export interface NpmAccount {
  readonly token: string;
  readonly secondFactor: { readonly type: "totp"; readonly secret: string };
}

export interface CodeRepositoryRecord {
  readonly id: string;
  readonly organizationId: string;
}

export interface PackageRecord {
  readonly codeRepositoryId: string;
  readonly trustedPublishers: ReadonlyArray<{ readonly environment: string; readonly registeredAt: number }>;
}

/** Jive's own records of organizations, code repositories, connections and packages. */
export interface IProvisioningRecords {
  findCodeRepository(caller: PipelineCaller): Effect.Effect<Option.Option<CodeRepositoryRecord>>;
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

/** The organization's package-registry connector (jive-connector-package-registry-npm's functions). */
export interface IRegistryConnector {
  createPlaceholder(input: { readonly packageName: string; readonly account: NpmAccount }): Effect.Effect<
    { readonly status: "created"; readonly version: string } | { readonly status: "alreadyExists" } | { readonly status: "maintainedByAnotherAccount" },
    Error
  >;
  listTrustedPublishers(input: { readonly packageName: string; readonly account: NpmAccount }): Effect.Effect<ReadonlyArray<ListedPublisher>, Error>;
  registerTrustedPublisher(input: { readonly packageName: string; readonly publisher: PublisherClaims; readonly account: NpmAccount }): Effect.Effect<void, Error>;
  removeTrustedPublisher(input: { readonly packageName: string; readonly id: string; readonly account: NpmAccount }): Effect.Effect<void, Error>;
}
export class RegistryConnector extends Context.Service<RegistryConnector, IRegistryConnector>()("RegistryConnector") {}

export type ProvisionOutcome = { readonly status: "ready" } | { readonly status: "inProgress" };

/**
 * Checks the caller's repository and package binding, takes the package's claim (or answers `inProgress`), and
 * through the organization's npm connection creates the package if missing and makes sure a publisher for the
 * caller's workflow and environment can publish, replacing one npm may have expired. The claim is released
 * however this ends.
 */
export function provisionPackage(input: {
  readonly caller: PipelineCaller;
  readonly packageName: string;
  readonly now: number;
}): Effect.Effect<ProvisionOutcome, ProvisionRefused | Error, ProvisioningRecords | RegistryConnector> {
  return Effect.gen(function* () {
    const records = yield* ProvisioningRecords;
    const { caller, packageName } = input;

    const maybeRepository = yield* records.findCodeRepository(caller);
    if (Option.isNone(maybeRepository)) {
      return yield* new ProvisionRefused({
        reason: `${caller.repository.owner}/${caller.repository.name} (id ${caller.repositoryId}) is not a code repository registered with Jive`,
      });
    }
    const repository = maybeRepository.value;
    const maybePackage = yield* records.findPackage(packageName);
    if (Option.isSome(maybePackage) && maybePackage.value.codeRepositoryId !== repository.id) {
      return yield* new ProvisionRefused({ reason: `${packageName} is provisioned for another code repository` });
    }

    const maybeHolder = yield* records.claim(packageName);
    if (Option.isNone(maybeHolder)) return { status: "inProgress" } as const;
    return yield* pipe(
      provisionClaimed({ ...input, repository, maybePackage }),
      Effect.ensuring(records.release({ packageName, holder: maybeHolder.value })),
    );
  });
}

function provisionClaimed(input: {
  readonly caller: PipelineCaller;
  readonly packageName: string;
  readonly now: number;
  readonly repository: CodeRepositoryRecord;
  readonly maybePackage: Option.Option<PackageRecord>;
}): Effect.Effect<ProvisionOutcome, ProvisionRefused | Error, ProvisioningRecords | RegistryConnector> {
  return Effect.gen(function* () {
    const records = yield* ProvisioningRecords;
    const connector = yield* RegistryConnector;
    const { caller, packageName, repository, maybePackage } = input;

    const maybeAccount = yield* records.npmAccount(repository.organizationId);
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
      repository: caller.repository,
      workflowFile: caller.workflowFile,
      environment: caller.environment,
    };
    const maybeRegisteredAt = pipe(
      maybePackage,
      Option.flatMap((record) => Option.fromUndefinedOr(record.trustedPublishers.find((publisher) => publisher.environment === caller.environment))),
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
      codeRepositoryId: repository.id,
      registeredPublisherFor: plan.action === "register" ? Option.some(caller.environment) : Option.none(),
    });
    return { status: "ready" } as const;
  });
}
