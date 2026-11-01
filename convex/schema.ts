import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Jive's core resources (design doc §3): organizations own connections, code repositories and packages; people
 * sign in to accounts with passkeys and act through sessions. Only what `packages.provision` and signing in need
 * exists so far.
 */
export default defineSchema({
  /**
   * A person. `webAuthnUserId` is the WebAuthn user handle their passkeys were registered with (random, drawn
   * before the account exists), and `username` is derived from it.
   */
  accounts: defineTable({
    username: v.string(),
    webAuthnUserId: v.string(),
    createdAt: v.number(),
  }).index("by_username", ["username"]),

  /**
   * A passkey with relying party `jive.sh`. `publicKey` is the COSE key, base64url. No signature counter: synced
   * passkeys report zero, so a stored counter would only reject real sign-ins.
   */
  passkeys: defineTable({
    accountId: v.id("accounts"),
    credentialId: v.string(),
    publicKey: v.string(),
    createdAt: v.number(),
  }).index("by_credential_id", ["credentialId"]).index("by_account", ["accountId"]),

  /**
   * A single-use WebAuthn challenge, stored as its SHA-256. A registration challenge carries the user handle and
   * username its options were issued for, so the account created is the one the passkey was made for.
   */
  webAuthnChallenges: defineTable({
    challengeHash: v.string(),
    purpose: v.union(v.literal("registration"), v.literal("signIn")),
    registration: v.optional(v.object({ webAuthnUserId: v.string(), username: v.string() })),
    expiresAt: v.number(),
  }).index("by_challenge_hash", ["challengeHash"]),

  /**
   * A session: what every call is made with (Alex, 2026-10-28: "There's a session token. That's it"). Only the
   * token's SHA-256 is stored. `origin` says how it was opened: a passkey ceremony in a browser, or a program (a
   * CLI or daemon) claiming a sign-in request a person approved with a passkey.
   */
  sessions: defineTable({
    accountId: v.id("accounts"),
    tokenHash: v.string(),
    origin: v.union(v.literal("browser"), v.literal("signInRequest")),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  }).index("by_token_hash", ["tokenHash"]).index("by_account", ["accountId"]),

  /**
   * A code repository's pipeline session, opened by exchanging a deploy job's GitHub Actions ID token
   * (`pipelineSessions:signIn`). A table of its own because it acts as a code repository, not a person: it holds no
   * account, and carries the job's checked claims that provisioning acts on. Only the token's SHA-256 is stored;
   * each row is deleted when it expires.
   */
  pipelineSessions: defineTable({
    codeRepositoryId: v.id("codeRepositories"),
    tokenHash: v.string(),
    repository: v.object({ owner: v.string(), name: v.string() }),
    environment: v.string(),
    workflowFile: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_token_hash", ["tokenHash"]),

  /**
   * An account's SSH key (Alex, 2026-11-01: "The ssh key will be saved on the account"). One per account,
   * generated here; the private key never leaves the server. `sealedPrivateKey` is its PKCS#8, AES-256-GCM sealed
   * under `CONNECTION_KEY` version `keyVersion`, as connections are; `publicKey` is the OpenSSH line.
   */
  sshKeys: defineTable({
    accountId: v.id("accounts"),
    publicKey: v.string(),
    sealedPrivateKey: v.string(),
    keyVersion: v.number(),
    createdAt: v.number(),
  }).index("by_account", ["accountId"]),

  /**
   * A program on a person's machine waiting to be signed in: it opens the request and keeps the claim secret
   * (stored as its SHA-256), the person approves it on `jive.sh/login?request=<id>` with a passkey, and the
   * program claims a session of its own. `confirmationCode` is shown by both the program and the page.
   */
  signInRequests: defineTable({
    claimSecretHash: v.string(),
    confirmationCode: v.string(),
    approvedAccountId: v.optional(v.id("accounts")),
    claimedAt: v.optional(v.number()),
    expiresAt: v.number(),
  }),

  organizations: defineTable({
    name: v.string(),
  }).index("by_name", ["name"]),

  /**
   * A connector initialised for an organization. `sealedCredential` is the connector's account (for npm, a
   * token from a person's npm login) as JSON, AES-256-GCM sealed under `CONNECTION_KEY` version `keyVersion`
   * (`<nonce>.<ciphertext>`, base64url), the way @jive-sh/app's Cloudflare backend did.
   */
  connections: defineTable({
    organizationId: v.id("organizations"),
    connector: v.literal("npm"),
    sealedCredential: v.string(),
    keyVersion: v.number(),
    createdAt: v.number(),
  }).index("by_organization_and_connector", ["organizationId", "connector"]),

  /**
   * A person's single-use permission to store an organization's npm connection, issued by an internal action (so
   * only a deployment admin gets one) and redeemed by `connections:completeNpmConnection`, which lets the
   * credential travel in an HTTPS body instead of a command line. Only the SHA-256 of the id is stored.
   */
  connectionRequests: defineTable({
    organizationId: v.id("organizations"),
    connector: v.literal("npm"),
    requestHash: v.string(),
    expiresAt: v.number(),
  }).index("by_request_hash", ["requestHash"]),

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
