/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    npmConnection: {
      ensurePasskey: FunctionReference<
        "action",
        "internal",
        { organizationId: string },
        { credentialId: string; publicKeySpki: string },
        Name
      >;
      markRegistered: FunctionReference<
        "mutation",
        "internal",
        { organizationId: string },
        null,
        Name
      >;
      save: FunctionReference<
        "action",
        "internal",
        { organizationId: string; token: string },
        null,
        Name
      >;
      sign: FunctionReference<
        "action",
        "internal",
        { challenge: ArrayBuffer; organizationId: string },
        { credentialId: string; signature: ArrayBuffer },
        Name
      >;
      status: FunctionReference<
        "query",
        "internal",
        { organizationId: string },
        { hasToken: boolean; passkeyRegistered: boolean },
        Name
      >;
      token: FunctionReference<
        "action",
        "internal",
        { organizationId: string },
        null | { token: string },
        Name
      >;
    };
    ssh: {
      createKey: FunctionReference<
        "action",
        "internal",
        { accountId: string; username: string },
        { publicKey: string },
        Name
      >;
      publicKey: FunctionReference<
        "query",
        "internal",
        { accountId: string },
        null | { publicKey: string },
        Name
      >;
      sealed: FunctionReference<
        "query",
        "internal",
        { accountId: string },
        null | { keyVersion: number; sealedPrivateKey: string },
        Name
      >;
      sign: FunctionReference<
        "action",
        "internal",
        { accountId: string; data: ArrayBuffer },
        { signature: ArrayBuffer },
        Name
      >;
    };
  };
