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
  accounts: {
    me: FunctionReference<
      "query",
      "public",
      { sessionToken: string },
      null | {
        createdAt: number;
        passkeys: Array<{ createdAt: number; credentialId: string }>;
        username: string;
      }
    >;
  };
  auth: {
    register: FunctionReference<
      "action",
      "public",
      { challenge: string; response: any; signInRequestId?: string },
      { expiresAt: number; sessionToken: string; username: string }
    >;
    registrationOptions: FunctionReference<
      "action",
      "public",
      {},
      { options: any }
    >;
    signIn: FunctionReference<
      "action",
      "public",
      { challenge: string; response: any; signInRequestId?: string },
      { expiresAt: number; sessionToken: string; username: string }
    >;
    signInOptions: FunctionReference<"action", "public", {}, { options: any }>;
  };
  connections: {
    completeNpmConnection: FunctionReference<
      "action",
      "public",
      { requestId: string; token: string },
      null
    >;
  };
  packages: {
    provision: FunctionReference<
      "action",
      "public",
      { packageName: string; registry: "npm"; sessionToken: string },
      | { status: "ready" }
      | { status: "inProgress" }
      | { reason: string; status: "refused" }
    >;
  };
  pipelineSessions: {
    signIn: FunctionReference<
      "action",
      "public",
      {},
      | { expiresAt: number; sessionToken: string; status: "signedIn" }
      | { reason: string; status: "refused" }
    >;
  };
  sessions: {
    signOut: FunctionReference<
      "mutation",
      "public",
      { sessionToken: string },
      null
    >;
  };
  signInRequests: {
    claim: FunctionReference<
      "action",
      "public",
      { claimSecret: string; requestId: string },
      | { status: "pending" }
      | { expiresAt: number; sessionToken: string; status: "approved" }
      | { status: "gone" }
    >;
    describe: FunctionReference<
      "query",
      "public",
      { requestId: string },
      null | { confirmationCode: string; status: "pending" | "approved" }
    >;
    open: FunctionReference<
      "action",
      "public",
      {},
      {
        claimSecret: string;
        confirmationCode: string;
        expiresAt: number;
        loginUrl: string;
        requestId: string;
      }
    >;
  };
  ssh: {
    createKey: FunctionReference<
      "action",
      "public",
      { sessionToken: string },
      { publicKey: string }
    >;
    publicKey: FunctionReference<
      "query",
      "public",
      { sessionToken: string },
      null | { publicKey: string }
    >;
    sign: FunctionReference<
      "action",
      "public",
      { data: ArrayBuffer; sessionToken: string },
      { signature: ArrayBuffer }
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
  auth: {
    createAccount: FunctionReference<
      "mutation",
      "internal",
      {
        credentialId: string;
        publicKey: string;
        signInRequestId?: string;
        tokenHash: string;
        username: string;
        webAuthnUserId: string;
      },
      { expiresAt: number }
    >;
    deleteChallenge: FunctionReference<
      "mutation",
      "internal",
      { id: Id<"webAuthnChallenges"> },
      null
    >;
    openSession: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        signInRequestId?: string;
        tokenHash: string;
      },
      { expiresAt: number; username: string }
    >;
    passkeyByCredentialId: FunctionReference<
      "query",
      "internal",
      { credentialId: string },
      null | {
        accountId: Id<"accounts">;
        credentialId: string;
        publicKey: string;
      }
    >;
    spendChallenge: FunctionReference<
      "mutation",
      "internal",
      { challengeHash: string; purpose: "registration" | "signIn" },
      null | { registration?: { username: string; webAuthnUserId: string } }
    >;
    storeChallenge: FunctionReference<
      "mutation",
      "internal",
      {
        challengeHash: string;
        purpose: "registration" | "signIn";
        registration?: { username: string; webAuthnUserId: string };
      },
      null
    >;
    usernameTaken: FunctionReference<
      "query",
      "internal",
      { username: string },
      boolean
    >;
  };
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
  pipelineSessions: {
    deleteSession: FunctionReference<
      "mutation",
      "internal",
      { id: Id<"pipelineSessions"> },
      null
    >;
    open: FunctionReference<
      "mutation",
      "internal",
      {
        caller: {
          environment: string;
          repository: { name: string; owner: string };
          repositoryId: string;
          repositoryOwnerId: string;
          workflowFile: string;
        };
        tokenHash: string;
      },
      null | { expiresAt: number }
    >;
    pipeline: FunctionReference<
      "query",
      "internal",
      { sessionToken: string },
      null | {
        codeRepositoryId: Id<"codeRepositories">;
        environment: string;
        organizationId: Id<"organizations">;
        repository: { name: string; owner: string };
        workflowFile: string;
      }
    >;
  };
  seed: {
    accountWithPasskey: FunctionReference<
      "mutation",
      "internal",
      {
        credentialId: string;
        passkeyCreatedAt: number;
        publicKey: string;
        webAuthnUserId: string;
      },
      { created: boolean; username: string }
    >;
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
  signInRequests: {
    claimWithToken: FunctionReference<
      "mutation",
      "internal",
      { claimSecretHash: string; requestId: string; tokenHash: string },
      | { status: "pending" }
      | { expiresAt: number; status: "approved" }
      | { status: "gone" }
    >;
    deleteRequest: FunctionReference<
      "mutation",
      "internal",
      { id: Id<"signInRequests"> },
      null
    >;
    store: FunctionReference<
      "mutation",
      "internal",
      { claimSecretHash: string; confirmationCode: string },
      { expiresAt: number; requestId: string }
    >;
  };
  ssh: {
    caller: FunctionReference<
      "query",
      "internal",
      { sessionToken: string },
      null | {
        accountId: Id<"accounts">;
        publicKey: null | string;
        username: string;
      }
    >;
    sealedKey: FunctionReference<
      "query",
      "internal",
      { sessionToken: string },
      null | { sealed: null | { keyVersion: number; sealedPrivateKey: string } }
    >;
    storeKey: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        keyVersion: number;
        publicKey: string;
        sealedPrivateKey: string;
      },
      string
    >;
  };
};

export declare const components: {
  packageRegistryNpm: import("jive-resource-connector-package-registry-npm/_generated/component.js").ComponentApi<"packageRegistryNpm">;
};
