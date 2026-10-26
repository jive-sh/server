import { v } from "convex/values";
import { Effect, Layer, Option, Schema, pipe } from "effect";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { authorizePipelineCaller } from "./model/pipelineCaller";
import {
  ProvisioningRecords,
  RegistryConnector,
  provisionPackage,
  type IProvisioningRecords,
  type IRegistryConnector,
  type NpmAccount,
} from "./model/provisioning";
import { open, parseConnectionKey } from "./model/sealing";

/** How long a provisioning's claim on a package lasts before another caller may take it over (§9). */
const CLAIM_MS = 5 * 60 * 1000;

const NpmCredential = Schema.fromJsonString(Schema.Struct({
  token: Schema.String,
  secondFactor: Schema.Struct({ type: Schema.Literal("totp"), secret: Schema.String }),
}));

/** Effect's wrapper around one Convex call; a function's failure becomes the Error it threw. */
function call<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
}

/** Jive's records, reached from an action through internal queries and mutations. */
function recordsOver(ctx: ActionCtx): IProvisioningRecords {
  return {
    findCodeRepository: (caller) => pipe(
      call(() => ctx.runQuery(internal.packages.codeRepositoryByGithubIds, { repositoryId: caller.repositoryId, repositoryOwnerId: caller.repositoryOwnerId })),
      Effect.map(Option.fromNullOr),
      Effect.orDie,
    ),
    findPackage: (packageName) => pipe(
      call(() => ctx.runQuery(internal.packages.packageByName, { packageName })),
      Effect.map(Option.fromNullOr),
      Effect.orDie,
    ),
    npmAccount: (organizationId) => Effect.gen(function* () {
      const sealed = yield* call(() => ctx.runQuery(internal.connections.sealedNpmConnection, { organizationId: organizationId as Id<"organizations"> }));
      if (sealed === null) return Option.none<NpmAccount>();
      const key = yield* pipe(parseConnectionKey(process.env.CONNECTION_KEY), Effect.mapError((e) => new Error(e.message)));
      if (key.version !== sealed.keyVersion) {
        return yield* Effect.fail(new Error(`the npm connection is sealed under CONNECTION_KEY version ${sealed.keyVersion}, but the deployment holds version ${key.version}`));
      }
      const plaintext = yield* pipe(open(key, sealed.sealedCredential), Effect.mapError((e) => new Error(e.message)));
      const credential = yield* pipe(
        Schema.decodeUnknownEffect(NpmCredential)(plaintext),
        // The schema error would quote the plaintext, which holds the credential.
        Effect.mapError(() => new Error("the npm connection's credential is not { token, secondFactor }")),
      );
      return Option.some<NpmAccount>(credential);
    }),
    claim: (packageName) => pipe(
      call(() => ctx.runMutation(internal.packages.claim, { packageName, holder: crypto.randomUUID() })),
      Effect.map(Option.fromNullOr),
      Effect.orDie,
    ),
    release: ({ packageName, holder }) => pipe(call(() => ctx.runMutation(internal.packages.release, { packageName, holder })), Effect.orDie),
    recordProvisioned: ({ packageName, codeRepositoryId, registeredPublisherFor }) => pipe(
      call(() => ctx.runMutation(internal.packages.recordProvisioned, {
        packageName,
        codeRepositoryId: codeRepositoryId as Id<"codeRepositories">,
        registeredPublisherFor: Option.getOrUndefined(registeredPublisherFor),
      })),
      Effect.orDie,
    ),
  };
}

/** The installed npm connector's functions. */
function npmConnectorOver(ctx: ActionCtx): IRegistryConnector {
  const registry = components.packageRegistryNpm.packageRegistry;
  return {
    createPlaceholder: (args) => call(() => ctx.runAction(registry.createPlaceholder, args)),
    listTrustedPublishers: (args) => call(() => ctx.runAction(registry.listTrustedPublishers, args)),
    registerTrustedPublisher: (args) => pipe(call(() => ctx.runAction(registry.registerTrustedPublisher, args)), Effect.asVoid),
    removeTrustedPublisher: (args) => pipe(call(() => ctx.runAction(registry.removeTrustedPublisher, args)), Effect.asVoid),
  };
}

/**
 * Makes a registry package ready for the calling deploy job to publish by trusted publishing (design doc §3).
 * Called by jive-abstract-library's deploy, with the job's GitHub Actions ID token, right before every publish.
 * `refused` says why; `inProgress` means another deploy job holds the package's claim, and the caller asks again.
 * Any other failure is thrown, and the deploy fails without publishing.
 */
export const provision = action({
  args: { registry: v.literal("npm"), packageName: v.string() },
  returns: v.union(
    v.object({ status: v.literal("ready") }),
    v.object({ status: v.literal("inProgress") }),
    v.object({ status: v.literal("refused"), reason: v.string() }),
  ),
  handler: async (ctx, { packageName }) => {
    const identity = await ctx.auth.getUserIdentity();
    const program = pipe(
      identity === null
        ? Effect.succeed({ status: "refused", reason: "the call carries no GitHub Actions ID token for https://api.jive.sh" } as const)
        : pipe(
          authorizePipelineCaller(identity),
          Effect.flatMap((caller) => provisionPackage({ caller, packageName, now: Date.now() })),
          Effect.catchTag("ProvisionRefused", ({ reason }) => Effect.succeed({ status: "refused", reason } as const)),
        ),
      Effect.tap((outcome) => Effect.log(`provision ${packageName}: ${outcome.status}${outcome.status === "refused" ? `: ${outcome.reason}` : ""}`)),
      Effect.provide(Layer.mergeAll(
        Layer.succeed(ProvisioningRecords, recordsOver(ctx)),
        Layer.succeed(RegistryConnector, npmConnectorOver(ctx)),
      )),
    );
    return await Effect.runPromise(program);
  },
});

export const codeRepositoryByGithubIds = internalQuery({
  args: { repositoryId: v.string(), repositoryOwnerId: v.string() },
  returns: v.union(v.null(), v.object({ id: v.string(), organizationId: v.string() })),
  handler: async (ctx, { repositoryId, repositoryOwnerId }) => {
    const repository = await ctx.db
      .query("codeRepositories")
      .withIndex("by_github_ids", (q) => q.eq("repositoryId", repositoryId).eq("repositoryOwnerId", repositoryOwnerId))
      .unique();
    return repository === null ? null : { id: repository._id, organizationId: repository.organizationId };
  },
});

export const packageByName = internalQuery({
  args: { packageName: v.string() },
  returns: v.union(v.null(), v.object({
    codeRepositoryId: v.string(),
    trustedPublishers: v.array(v.object({ environment: v.string(), registeredAt: v.number() })),
  })),
  handler: async (ctx, { packageName }) => {
    const record = await ctx.db.query("packages").withIndex("by_registry_and_name", (q) => q.eq("registry", "npm").eq("name", packageName)).unique();
    return record === null ? null : { codeRepositoryId: record.codeRepositoryId, trustedPublishers: record.trustedPublishers };
  },
});

/** Takes the package's claim for `holder`, or returns null while another unexpired claim stands. */
export const claim = internalMutation({
  args: { packageName: v.string(), holder: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { packageName, holder }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("provisioningClaims")
      .withIndex("by_registry_and_package", (q) => q.eq("registry", "npm").eq("packageName", packageName))
      .unique();
    if (existing !== null && existing.expiresAt > now) return null;
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("provisioningClaims", { registry: "npm", packageName, holder, expiresAt: now + CLAIM_MS });
    return holder;
  },
});

/** Releases the claim if `holder` still holds it; one taken over after expiring is left to its new holder. */
export const release = internalMutation({
  args: { packageName: v.string(), holder: v.string() },
  returns: v.null(),
  handler: async (ctx, { packageName, holder }) => {
    const existing = await ctx.db
      .query("provisioningClaims")
      .withIndex("by_registry_and_package", (q) => q.eq("registry", "npm").eq("packageName", packageName))
      .unique();
    if (existing !== null && existing.holder === holder) await ctx.db.delete(existing._id);
    return null;
  },
});

export const recordProvisioned = internalMutation({
  args: { packageName: v.string(), codeRepositoryId: v.id("codeRepositories"), registeredPublisherFor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { packageName, codeRepositoryId, registeredPublisherFor }) => {
    const now = Date.now();
    const record = await ctx.db.query("packages").withIndex("by_registry_and_name", (q) => q.eq("registry", "npm").eq("name", packageName)).unique();
    const publishers = (record?.trustedPublishers ?? []).filter((publisher) => publisher.environment !== registeredPublisherFor);
    const trustedPublishers = registeredPublisherFor === undefined ? publishers : [...publishers, { environment: registeredPublisherFor, registeredAt: now }];
    if (record === null) {
      await ctx.db.insert("packages", { registry: "npm", name: packageName, codeRepositoryId, trustedPublishers, lastProvisionedAt: now });
    } else {
      await ctx.db.patch(record._id, { codeRepositoryId, trustedPublishers, lastProvisionedAt: now });
    }
    return null;
  },
});
