/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { GenericId as Id } from "convex/values";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  connections: {
    completeNpmConnection: FunctionReference<
      "action",
      "public",
      { requestId: string; token: string; totpSecret: string },
      null
    >;
  };
  packages: {
    provision: FunctionReference<
      "action",
      "public",
      { packageName: string; registry: "npm" },
      | { status: "ready" }
      | { status: "inProgress" }
      | { reason: string; status: "refused" }
    >;
  };
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: {
  connections: {
    openNpmConnectionRequest: FunctionReference<
      "action",
      "internal",
      { organizationName: string },
      { deploymentUrl: string; requestId: string }
    >;
    redeemNpmConnectionRequest: FunctionReference<
      "mutation",
      "internal",
      { requestHash: string },
      null | Id<"organizations">
    >;
    replaceNpmConnection: FunctionReference<
      "mutation",
      "internal",
      {
        keyVersion: number;
        organizationId: Id<"organizations">;
        sealedCredential: string;
      },
      null
    >;
    sealedNpmConnection: FunctionReference<
      "query",
      "internal",
      { organizationId: Id<"organizations"> },
      null | { keyVersion: number; sealedCredential: string }
    >;
    storeNpmConnectionRequest: FunctionReference<
      "mutation",
      "internal",
      { organizationName: string; requestHash: string },
      null
    >;
  };
  packages: {
    claim: FunctionReference<
      "mutation",
      "internal",
      { holder: string; packageName: string },
      null | string
    >;
    codeRepositoryByGithubIds: FunctionReference<
      "query",
      "internal",
      { repositoryId: string; repositoryOwnerId: string },
      null | { id: string; organizationId: string }
    >;
    packageByName: FunctionReference<
      "query",
      "internal",
      { packageName: string },
      null | {
        codeRepositoryId: string;
        trustedPublishers: Array<{ environment: string; registeredAt: number }>;
      }
    >;
    recordProvisioned: FunctionReference<
      "mutation",
      "internal",
      {
        codeRepositoryId: Id<"codeRepositories">;
        packageName: string;
        registeredPublisherFor?: string;
      },
      null
    >;
    release: FunctionReference<
      "mutation",
      "internal",
      { holder: string; packageName: string },
      null
    >;
  };
  seed: {
    organizationWithRepository: FunctionReference<
      "mutation",
      "internal",
      {
        organizationName: string;
        repository: {
          name: string;
          owner: string;
          repositoryId: string;
          repositoryOwnerId: string;
        };
      },
      {
        codeRepositoryId: Id<"codeRepositories">;
        organizationId: Id<"organizations">;
      }
    >;
  };
};

export declare const components: {
  packageRegistryNpm: import("jive-connector-package-registry-npm/_generated/component.js").ComponentApi<"packageRegistryNpm">;
};
