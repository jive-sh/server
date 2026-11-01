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
import { anyApi, componentsGeneric } from "convex/server";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: {
  npmConnection: {
    ensurePasskey: FunctionReference<
      "action",
      "public",
      { organizationId: string },
      { credentialId: string; publicKeySpki: string }
    >;
    markRegistered: FunctionReference<
      "mutation",
      "public",
      { organizationId: string },
      null
    >;
    save: FunctionReference<
      "action",
      "public",
      { organizationId: string; token: string },
      null
    >;
    sign: FunctionReference<
      "action",
      "public",
      { challenge: ArrayBuffer; organizationId: string },
      { credentialId: string; signature: ArrayBuffer }
    >;
    status: FunctionReference<
      "query",
      "public",
      { organizationId: string },
      { hasToken: boolean; passkeyRegistered: boolean }
    >;
    token: FunctionReference<
      "action",
      "public",
      { organizationId: string },
      null | { token: string }
    >;
  };
  ssh: {
    createKey: FunctionReference<
      "action",
      "public",
      { accountId: string; username: string },
      { publicKey: string }
    >;
    importExisting: FunctionReference<
      "mutation",
      "public",
      {
        accountId: string;
        createdAt: number;
        keyVersion: number;
        publicKey: string;
        sealedPrivateKey: string;
      },
      "copied" | "alreadyPresent"
    >;
    publicKey: FunctionReference<
      "query",
      "public",
      { accountId: string },
      null | { publicKey: string }
    >;
    sealed: FunctionReference<
      "query",
      "public",
      { accountId: string },
      null | { keyVersion: number; sealedPrivateKey: string }
    >;
    sign: FunctionReference<
      "action",
      "public",
      { accountId: string; data: ArrayBuffer },
      { signature: ArrayBuffer }
    >;
  };
} = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: {
  npmConnection: {
    passkeyPublic: FunctionReference<
      "query",
      "internal",
      { organizationId: string },
      null | { credentialId: string; publicKeySpki: string }
    >;
    sealedPasskey: FunctionReference<
      "query",
      "internal",
      { organizationId: string },
      null | {
        credentialId: string;
        keyVersion: number;
        sealedPrivateKey: string;
      }
    >;
    sealedToken: FunctionReference<
      "query",
      "internal",
      { organizationId: string },
      null | { keyVersion: number; sealedToken: string }
    >;
    store: FunctionReference<
      "mutation",
      "internal",
      { keyVersion: number; organizationId: string; sealedToken: string },
      null
    >;
    storePasskey: FunctionReference<
      "mutation",
      "internal",
      {
        credentialId: string;
        keyVersion: number;
        organizationId: string;
        publicKeySpki: string;
        sealedPrivateKey: string;
      },
      { credentialId: string; publicKeySpki: string }
    >;
  };
  ssh: {
    publicKeyForAccount: FunctionReference<
      "query",
      "internal",
      { accountId: string },
      null | string
    >;
    sealedForAccount: FunctionReference<
      "query",
      "internal",
      { accountId: string },
      null | { keyVersion: number; sealedPrivateKey: string }
    >;
    storeKey: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: string;
        keyVersion: number;
        publicKey: string;
        sealedPrivateKey: string;
      },
      string
    >;
  };
} = anyApi as any;

export const components = componentsGeneric() as unknown as {};
