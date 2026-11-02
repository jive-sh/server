/* eslint-disable */
/**
 * Generated data model types.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
  AnyDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";

/**
 * A type describing your Convex data model.
 *
 * This type includes information about what tables you have, the type of
 * documents stored in those tables, and the indexes defined on them.
 *
 * This type is used to parameterize methods like `queryGeneric` and
 * `mutationGeneric` to make them type-safe.
 */

export type DataModel = {
  accounts: {
    document: {
      createdAt: number;
      username: string;
      webAuthnUserId: string;
      _id: Id<"accounts">;
      _creationTime: number;
    };
    fieldPaths:
      "_creationTime" | "_id" | "createdAt" | "username" | "webAuthnUserId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_username: ["username", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  approvalDevices: {
    document: {
      accountId: Id<"accounts">;
      createdAt: number;
      expoPushToken: string;
      label: string;
      _id: Id<"approvalDevices">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "accountId"
      | "createdAt"
      | "expoPushToken"
      | "label";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_account: ["accountId", "_creationTime"];
      by_expo_push_token: ["expoPushToken", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  codeRepositories: {
    document: {
      name: string;
      organizationId: Id<"organizations">;
      owner: string;
      repositoryId: string;
      repositoryOwnerId: string;
      _id: Id<"codeRepositories">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "name"
      | "organizationId"
      | "owner"
      | "repositoryId"
      | "repositoryOwnerId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_github_ids: ["repositoryId", "repositoryOwnerId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  connectionRequests: {
    document: {
      connector: "npm";
      expiresAt: number;
      organizationId: Id<"organizations">;
      requestHash: string;
      _id: Id<"connectionRequests">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "connector"
      | "expiresAt"
      | "organizationId"
      | "requestHash";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_request_hash: ["requestHash", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  organizations: {
    document: { name: string; _id: Id<"organizations">; _creationTime: number };
    fieldPaths: "_creationTime" | "_id" | "name";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_name: ["name", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  passkeys: {
    document: {
      accountId: Id<"accounts">;
      createdAt: number;
      credentialId: string;
      publicKey: string;
      _id: Id<"passkeys">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "accountId"
      | "createdAt"
      | "credentialId"
      | "publicKey";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_account: ["accountId", "_creationTime"];
      by_credential_id: ["credentialId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  pipelineSessions: {
    document: {
      codeRepositoryId: Id<"codeRepositories">;
      createdAt: number;
      environment: string;
      expiresAt: number;
      repository: { name: string; owner: string };
      tokenHash: string;
      workflowFile: string;
      _id: Id<"pipelineSessions">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "codeRepositoryId"
      | "createdAt"
      | "environment"
      | "expiresAt"
      | "repository"
      | "repository.name"
      | "repository.owner"
      | "tokenHash"
      | "workflowFile";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_token_hash: ["tokenHash", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  resourceImplementations: {
    document: {
      implementation: string;
      kind: string;
      organizationId: Id<"organizations">;
      _id: Id<"resourceImplementations">;
      _creationTime: number;
    };
    fieldPaths:
      "_creationTime" | "_id" | "implementation" | "kind" | "organizationId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_organization_and_kind: ["organizationId", "kind", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  sessions: {
    document: {
      accountId: Id<"accounts">;
      createdAt: number;
      expiresAt: number;
      origin: "browser" | "signInRequest";
      revokedAt?: number;
      tokenHash: string;
      _id: Id<"sessions">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "accountId"
      | "createdAt"
      | "expiresAt"
      | "origin"
      | "revokedAt"
      | "tokenHash";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_account: ["accountId", "_creationTime"];
      by_token_hash: ["tokenHash", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  signInRequests: {
    document: {
      approvedAccountId?: Id<"accounts">;
      claimSecretHash: string;
      claimedAt?: number;
      confirmationCode?: string;
      expiresAt: number;
      _id: Id<"signInRequests">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "approvedAccountId"
      | "claimedAt"
      | "claimSecretHash"
      | "confirmationCode"
      | "expiresAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  webAuthnChallenges: {
    document: {
      accountId?: Id<"accounts">;
      challengeHash: string;
      expiresAt: number;
      purpose: "registration" | "signIn" | "addPasskey";
      registration?: { username: string; webAuthnUserId: string };
      _id: Id<"webAuthnChallenges">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "accountId"
      | "challengeHash"
      | "expiresAt"
      | "purpose"
      | "registration"
      | "registration.username"
      | "registration.webAuthnUserId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_challenge_hash: ["challengeHash", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
};

/**
 * The names of all of your Convex tables.
 */
export type TableNames = TableNamesInDataModel<DataModel>;

/**
 * The type of a document stored in Convex.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Doc<TableName extends TableNames> = DocumentByName<
  DataModel,
  TableName
>;

/**
 * An identifier for a document in Convex.
 *
 * Convex documents are uniquely identified by their `Id`, which is accessible
 * on the `_id` field. To learn more, see [Document IDs](https://docs.convex.dev/using/document-ids).
 *
 * Documents can be loaded using `db.get(tableName, id)` in query and mutation functions.
 *
 * IDs are just strings at runtime, but this type can be used to distinguish them from other
 * strings when type checking.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Id<TableName extends TableNames | SystemTableNames> =
  GenericId<TableName>;
