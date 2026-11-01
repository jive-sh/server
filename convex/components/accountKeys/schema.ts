import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The component's own tables. Account and organization ids are the installing app's ids, stored as strings: a
 * component cannot reference the app's tables. The app resolves a session or a code repository, then passes the id.
 */
export default defineSchema({
  /**
   * One ed25519 SSH key per account. `sealedPrivateKey` is the PKCS#8, AES-256-GCM sealed under `CONNECTION_KEY`
   * version `keyVersion`. `publicKey` is the OpenSSH line.
   */
  sshKeys: defineTable({
    accountId: v.string(),
    publicKey: v.string(),
    sealedPrivateKey: v.string(),
    keyVersion: v.number(),
    createdAt: v.number(),
  }).index("by_account", ["accountId"]),

  /**
   * The organization's npm connection: the connector's account, a token from one npm login, sealed like a key.
   * One per organization. `passkeyRegistered` is set once npm has accepted the signing passkey beside it.
   */
  npmConnections: defineTable({
    organizationId: v.string(),
    connector: v.literal("npm"),
    sealedToken: v.string(),
    keyVersion: v.number(),
    passkeyRegistered: v.boolean(),
    createdAt: v.number(),
  }).index("by_organization_and_connector", ["organizationId", "connector"]),

  /**
   * The P-256 passkey registered on that npm account, one per organization. `publicKeySpki` is the SPKI, base64.
   * `sealedPrivateKey` is the PKCS#8, sealed like the token. The signature is raw ECDSA `r‖s`, not a WebAuthn
   * assertion.
   */
  signingPasskeys: defineTable({
    organizationId: v.string(),
    connector: v.literal("npm"),
    credentialId: v.string(),
    publicKeySpki: v.string(),
    sealedPrivateKey: v.string(),
    keyVersion: v.number(),
    createdAt: v.number(),
  }).index("by_organization_and_connector", ["organizationId", "connector"]),
});
