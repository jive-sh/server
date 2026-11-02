import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Jive's core resources (design doc §3): organizations own code repositories and configure one implementation per
 * resource kind; people sign in to accounts with passkeys and act through sessions. Each resource's instances (an
 * npm package) are held in that resource's component, and the organization's npm connection in `accountKeys`.
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
   * username its options were issued for, so the account created is the one the passkey was made for. An
   * `addPasskey` challenge carries the account a signed-in session is adding a passkey to.
   */
  webAuthnChallenges: defineTable({
    challengeHash: v.string(),
    purpose: v.union(v.literal("registration"), v.literal("signIn"), v.literal("addPasskey")),
    registration: v.optional(v.object({ webAuthnUserId: v.string(), username: v.string() })),
    accountId: v.optional(v.id("accounts")),
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
   * A program on a person's machine waiting to be signed in: it opens the request and keeps the claim secret
   * (stored as its SHA-256), the person approves it on `jive.sh/login?request=<id>` with a passkey, and the
   * program claims a session of its own.
   */
  signInRequests: defineTable({
    claimSecretHash: v.string(),
    /**
     * Only requests opened before 0.8.0 carry it; nothing writes or reads it. Each such request is deleted when it
     * expires (10 minutes), so the field goes in the release after this one.
     */
    confirmationCode: v.optional(v.string()),
    approvedAccountId: v.optional(v.id("accounts")),
    claimedAt: v.optional(v.number()),
    expiresAt: v.number(),
  }),

  /**
   * A phone that approves the account's program sign-ins: the Jive app on it, signed in, turned on phone approval
   * and registered its Expo push token. Each sign-in request opened for the account is pushed to it
   * (`approvalDevices.ts`). A token Expo reports as no longer registered is deleted.
   */
  approvalDevices: defineTable({
    accountId: v.id("accounts"),
    expoPushToken: v.string(),
    /** What the phone calls itself (`Pixel 9`), shown in the account's device list. */
    label: v.string(),
    createdAt: v.number(),
  }).index("by_account", ["accountId"]).index("by_expo_push_token", ["expoPushToken"]),

  organizations: defineTable({
    name: v.string(),
  }).index("by_name", ["name"]),

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
   * The one implementation an organization configured for a resource kind (Alex, 2026-11-01: "it should probably
   * only be provisioning the abstract. so `jive provision connector-package-registry` and then it talks to the jive org
   * which should have one impl configured"). `kind` is the abstract's kind path (`connector-package-registry`),
   * `implementation` the resource package (`jive-resource-connector-package-registry-npm`).
   */
  resourceImplementations: defineTable({
    organizationId: v.id("organizations"),
    kind: v.string(),
    implementation: v.string(),
  }).index("by_organization_and_kind", ["organizationId", "kind"]),
});
