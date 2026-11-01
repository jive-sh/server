import { v } from "convex/values";
import { Effect, Layer, Option, Schema, pipe } from "effect";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import {
  ProvisioningRecords,
  RegistryConnector,
  SecondFactorRequired,
  provisionPackage,
  type IProvisioningRecords,
  type IRegistryConnector,
  type NpmAccount,
} from "./model/provisioning";
import { openWithDeploymentKey } from "./model/sealing";

/** How long a provisioning's claim on a package lasts before another caller may take it over (§9). */
const CLAIM_MS = 5 * 60 * 1000;

/**
 * The sealed npm credential. Connections stored before 0.2.0 also hold an authenticator secret, which nothing reads
 * any more; decoding drops it.
 */
const NpmCredential = Schema.fromJsonString(Schema.Struct({ token: Schema.String }));

/** Effect's wrapper around one Convex call; a function's failure becomes the Error it threw. */
function call<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
}

/** Jive's records, reached from an action through internal queries and mutations. */
function recordsOver(ctx: ActionCtx): IProvisioningRecords {
  return {
    findPackage: (packageName) => pipe(
      call(() => ctx.runQuery(internal.packages.packageByName, { packageName })),
      Effect.map(Option.fromNullOr),
      Effect.orDie,
    ),
    npmAccount: (organizationId) => Effect.gen(function* () {
      const sealed = yield* call(() => ctx.runQuery(internal.connections.sealedNpmConnection, { organizationId: organizationId as Id<"organizations"> }));
      if (sealed === null) return Option.none<NpmAccount>();
      const plaintext = yield* pipe(
        openWithDeploymentKey({ sealed: sealed.sealedCredential, keyVersion: sealed.keyVersion }),
        Effect.mapError((e) => new Error(`the npm connection: ${e.message}`)),
      );
      const credential = yield* pipe(
        Schema.decodeUnknownEffect(NpmCredential)(plaintext),
        // The schema error would quote the plaintext, which holds the credential.
        Effect.mapError(() => new Error("the npm connection's credential is not { token }")),
      );
      return Option.some<NpmAccount>({ token: credential.token });
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

/**
 * A write's answer, with npm's second-factor page turned into `SecondFactorRequired`. No one-time password is ever
 * sent, so every write npm guards answers that.
 */
type SecondFactorAnswer = { readonly status: "secondFactorRequired"; readonly pageUrl: string; readonly resultUrl: string };

function isSecondFactorAnswer(answer: { readonly status: string }): answer is SecondFactorAnswer {
  return answer.status === "secondFactorRequired";
}

function answered<A extends { readonly status: string }>(
  operation: string,
  write: Effect.Effect<A, Error>,
): Effect.Effect<Exclude<A, SecondFactorAnswer>, SecondFactorRequired | Error> {
  return Effect.flatMap(write, (answer) => isSecondFactorAnswer(answer)
    ? Effect.fail(new SecondFactorRequired({ operation, pageUrl: answer.pageUrl }))
    // TypeScript does not narrow a generic union; the guard above removed this member.
    : Effect.succeed(answer as Exclude<A, SecondFactorAnswer>));
}

/** The installed npm connector's functions. */
function npmConnectorOver(ctx: ActionCtx): IRegistryConnector {
  const registry = components.packageRegistryNpm.packageRegistry;
  return {
    createPlaceholder: (args) => answered(`publish ${args.packageName}'s placeholder`, call(() => ctx.runAction(registry.createPlaceholder, args))),
    listTrustedPublishers: (args) => call(() => ctx.runAction(registry.listTrustedPublishers, args)),
    registerTrustedPublisher: (args) => pipe(
      answered(`register a trusted publisher on ${args.packageName}`, call(() => ctx.runAction(registry.registerTrustedPublisher, args))),
      Effect.asVoid,
    ),
    removeTrustedPublisher: (args) => pipe(
      answered(`remove trusted publisher ${args.id} from ${args.packageName}`, call(() => ctx.runAction(registry.removeTrustedPublisher, args))),
      Effect.asVoid,
    ),
  };
}

/**
 * Makes a registry package ready for the calling deploy job to publish by trusted publishing (design doc §3).
 * Called by jive-abstract-library's deploy right before every publish, with the pipeline session the job signed in
 * for (`pipelineSessions:signIn`). `refused` says why; `inProgress` means another deploy job holds the package's
 * claim, and the caller asks again. Any other failure is thrown, and the deploy fails without publishing.
 */
export const provision = action({
  args: { sessionToken: v.string(), registry: v.literal("npm"), packageName: v.string() },
  returns: v.union(
    v.object({ status: v.literal("ready") }),
    v.object({ status: v.literal("inProgress") }),
    v.object({ status: v.literal("refused"), reason: v.string() }),
  ),
  handler: async (ctx, { sessionToken, packageName }) => {
    const pipeline = await ctx.runQuery(internal.pipelineSessions.pipeline, { sessionToken });
    const program = pipe(
      pipeline === null
        ? Effect.succeed({ status: "refused", reason: "the session token opens no live pipeline session; sign the job in with pipelineSessions:signIn" } as const)
        : pipe(
          provisionPackage({ pipeline, packageName, now: Date.now() }),
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
