import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Jive's core resources (design doc §3): organizations own connections, code repositories and packages. Only
 * what `packages.provision` needs exists so far.
 */
export default defineSchema({
  organizations: defineTable({
    name: v.string(),
  }).index("by_name", ["name"]),

  /**
   * A connector initialised for an organization. `sealedCredential` is the connector's account (for npm, its
   * token and authenticator-app secret) as JSON, AES-256-GCM sealed under `CONNECTION_KEY` version `keyVersion`
   * (`<nonce>.<ciphertext>`, base64url), the way @jive-sh/app seals connections.
   */
  connections: defineTable({
    organizationId: v.id("organizations"),
    connector: v.literal("npm"),
    sealedCredential: v.string(),
    keyVersion: v.number(),
    createdAt: v.number(),
  }).index("by_organization_and_connector", ["organizationId", "connector"]),

  /**
   * A GitHub repository registered to an organization by its immutable ids, which is what lets its pipelines'
   * ID tokens in (§4, §6). `owner` and `name` are what npm's trusted publisher names; they can change on GitHub,
   * the ids cannot.
   */
  codeRepositories: defineTable({
    organizationId: v.id("organizations"),
    repositoryId: v.string(),
    repositoryOwnerId: v.string(),
    owner: v.string(),
    name: v.string(),
  }).index("by_github_ids", ["repositoryId", "repositoryOwnerId"]),

  /**
   * A registry package, bound to the code repository whose pipeline first provisioned it. `trustedPublishers`
   * records when Jive registered each environment's publisher, because npm does not say whether an unvalidated
   * publisher is still waiting for its first publish or expired.
   */
  packages: defineTable({
    registry: v.literal("npm"),
    name: v.string(),
    codeRepositoryId: v.id("codeRepositories"),
    trustedPublishers: v.array(v.object({ environment: v.string(), registeredAt: v.number() })),
    lastProvisionedAt: v.number(),
  }).index("by_registry_and_name", ["registry", "name"]),

  /**
   * At most one provisioning of a package at a time (§9): taken in a mutation, so Convex's serializable
   * transactions let one caller win, before the action calls npm. An action that dies never releases its claim,
   * so a claim past `expiresAt` may be taken over.
   */
  provisioningClaims: defineTable({
    registry: v.literal("npm"),
    packageName: v.string(),
    holder: v.string(),
    expiresAt: v.number(),
  }).index("by_registry_and_package", ["registry", "packageName"]),
});
