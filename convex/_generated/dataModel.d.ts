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
  connections: {
    document: {
      connector: "npm";
      createdAt: number;
      keyVersion: number;
      organizationId: Id<"organizations">;
      sealedCredential: string;
      _id: Id<"connections">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "connector"
      | "createdAt"
      | "keyVersion"
      | "organizationId"
      | "sealedCredential";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_organization_and_connector: [
        "organizationId",
        "connector",
        "_creationTime",
      ];
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
  packages: {
    document: {
      codeRepositoryId: Id<"codeRepositories">;
      lastProvisionedAt: number;
      name: string;
      registry: "npm";
      trustedPublishers: Array<{ environment: string; registeredAt: number }>;
      _id: Id<"packages">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "codeRepositoryId"
      | "lastProvisionedAt"
      | "name"
      | "registry"
      | "trustedPublishers";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_registry_and_name: ["registry", "name", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  provisioningClaims: {
    document: {
      expiresAt: number;
      holder: string;
      packageName: string;
      registry: "npm";
      _id: Id<"provisioningClaims">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "expiresAt"
      | "holder"
      | "packageName"
      | "registry";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_registry_and_package: ["registry", "packageName", "_creationTime"];
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
