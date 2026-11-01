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
  npmConnections: {
    document: {
      connector: "npm";
      createdAt: number;
      keyVersion: number;
      organizationId: string;
      passkeyRegistered: boolean;
      sealedToken: string;
      _id: Id<"npmConnections">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "connector"
      | "createdAt"
      | "keyVersion"
      | "organizationId"
      | "passkeyRegistered"
      | "sealedToken";
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
  signingPasskeys: {
    document: {
      connector: "npm";
      createdAt: number;
      credentialId: string;
      keyVersion: number;
      organizationId: string;
      publicKeySpki: string;
      sealedPrivateKey: string;
      _id: Id<"signingPasskeys">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "connector"
      | "createdAt"
      | "credentialId"
      | "keyVersion"
      | "organizationId"
      | "publicKeySpki"
      | "sealedPrivateKey";
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
  sshKeys: {
    document: {
      accountId: string;
      createdAt: number;
      keyVersion: number;
      publicKey: string;
      sealedPrivateKey: string;
      _id: Id<"sshKeys">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "accountId"
      | "createdAt"
      | "keyVersion"
      | "publicKey"
      | "sealedPrivateKey";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_account: ["accountId", "_creationTime"];
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
