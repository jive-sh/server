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
  approvalDevices: {
    disable: FunctionReference<
      "mutation",
      "public",
      { expoPushToken: string; sessionToken: string },
      null
    >;
    enable: FunctionReference<
      "mutation",
      "public",
      { expoPushToken: string; label: string; sessionToken: string },
      null
    >;
    list: FunctionReference<
      "query",
      "public",
      { sessionToken: string },
      null | Array<{ createdAt: number; expoPushToken: string; label: string }>
    >;
  };
  auth: {
    addPasskey: FunctionReference<
      "action",
      "public",
      { challenge: string; response: any; sessionToken: string },
      null
    >;
    addPasskeyOptions: FunctionReference<
      "action",
      "public",
      { sessionToken: string },
      { options: any }
    >;
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
  npmSessions: {
    markPasskeyRegistered: FunctionReference<
      "action",
      "public",
      { repositoryName: string; repositoryOwner: string; sessionToken: string },
      null
    >;
    save: FunctionReference<
      "action",
      "public",
      {
        repositoryName: string;
        repositoryOwner: string;
        sessionToken: string;
        token: string;
      },
      null
    >;
    status: FunctionReference<
      "query",
      "public",
      { repositoryName: string; repositoryOwner: string; sessionToken: string },
      { hasToken: boolean; passkeyRegistered: boolean }
    >;
    token: FunctionReference<
      "action",
      "public",
      { repositoryName: string; repositoryOwner: string; sessionToken: string },
      { token: string }
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
  provision: {
    default: FunctionReference<
      "action",
      "public",
      { instance: any; kind: string; sessionToken: string },
      | { instance: any; instanceId: string; status: "ready" }
      | { retryAfterSeconds: number; status: "inProgress" }
      | { reason: string; status: "personNeeded"; url: string }
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
  signingPasskey: {
    ensure: FunctionReference<
      "action",
      "public",
      { repositoryName: string; repositoryOwner: string; sessionToken: string },
      { credentialId: string; publicKeySpki: string }
    >;
    sign: FunctionReference<
      "action",
      "public",
      {
        challenge: string;
        repositoryName: string;
        repositoryOwner: string;
        sessionToken: string;
      },
      { signature: string }
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
      null | { status: "pending" | "approved" }
    >;
    open: FunctionReference<
      "action",
      "public",
      { previousSessionToken?: string },
      {
        approvalDevices: number;
        claimSecret: string;
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
  approvalDevices: {
    forgetUnregistered: FunctionReference<
      "mutation",
      "internal",
      { expoPushTokens: Array<string> },
      null
    >;
    pushSignInRequest: FunctionReference<
      "action",
      "internal",
      { accountId: Id<"accounts">; expiresAt: number; requestId: string },
      null
    >;
    pushTargets: FunctionReference<
      "query",
      "internal",
      { accountId: Id<"accounts"> },
      { expoPushTokens: Array<string>; username: string }
    >;
  };
  auth: {
    accountOfSession: FunctionReference<
      "query",
      "internal",
      { sessionToken: string },
      null | {
        accountId: Id<"accounts">;
        credentialIds: Array<string>;
        username: string;
        webAuthnUserId: string;
      }
    >;
    attachPasskey: FunctionReference<
      "mutation",
      "internal",
      { accountId: Id<"accounts">; credentialId: string; publicKey: string },
      null
    >;
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
      {
        challengeHash: string;
        purpose: "registration" | "signIn" | "addPasskey";
      },
      null | {
        accountId?: Id<"accounts">;
        registration?: { username: string; webAuthnUserId: string };
      }
    >;
    storeChallenge: FunctionReference<
      "mutation",
      "internal",
      {
        accountId?: Id<"accounts">;
        challengeHash: string;
        purpose: "registration" | "signIn" | "addPasskey";
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
    storeNpmConnectionRequest: FunctionReference<
      "mutation",
      "internal",
      { organizationName: string; requestHash: string },
      null
    >;
  };
  npmSessions: {
    organizationForRepository: FunctionReference<
      "query",
      "internal",
      { repositoryName: string; repositoryOwner: string; sessionToken: string },
      null | string
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
  provision: {
    configuredImplementation: FunctionReference<
      "query",
      "internal",
      { kind: string; organizationId: Id<"organizations"> },
      { implementation: null | string; organizationName: string }
    >;
    isPersonSession: FunctionReference<
      "query",
      "internal",
      { sessionToken: string },
      boolean
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
    resourceImplementation: FunctionReference<
      "mutation",
      "internal",
      { implementation: string; kind: string; organizationName: string },
      null
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
      { claimSecretHash: string; previousSessionTokenHash?: string },
      { approvalDevices: number; expiresAt: number; requestId: string }
    >;
  };
  ssh: {
    caller: FunctionReference<
      "query",
      "internal",
      { sessionToken: string },
      null | { accountId: Id<"accounts">; username: string }
    >;
    insertLegacy: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        createdAt: number;
        keyVersion: number;
        publicKey: string;
        sealedPrivateKey: string;
      },
      null
    >;
    legacyKey: FunctionReference<
      "query",
      "internal",
      { accountId: Id<"accounts"> },
      null | {
        createdAt: number;
        keyVersion: number;
        publicKey: string;
        sealedPrivateKey: string;
      }
    >;
    migrateToAccountKeys: FunctionReference<
      "mutation",
      "internal",
      { environment: string; sourceCommitSha: string },
      { alreadyPresent: number; copied: number }
    >;
    removeLegacy: FunctionReference<
      "mutation",
      "internal",
      { accountId: Id<"accounts"> },
      null
    >;
    sealedKey: FunctionReference<
      "query",
      "internal",
      { sessionToken: string },
      null | { sealed: null | { keyVersion: number; sealedPrivateKey: string } }
    >;
  };
};

export declare const components: {
  packageRegistryNpm: import("jive-resource-connector-package-registry-npm/_generated/component.js").ComponentApi<"packageRegistryNpm">;
  accountKeys: import("../components/accountKeys/_generated/component.js").ComponentApi<"accountKeys">;
};
