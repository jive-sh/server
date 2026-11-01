import type { ActionCtx } from "../_generated/server";
import { packageRegistryNpm } from "./packageRegistryNpm";
import type { PipelineSession } from "./pipelineSessions";

/**
 * The resource kinds this server provisions, and the implementations of each it has installed (design page:
 * "each resource kind is a connector abstract with a standard 'make sure this exists' call; an implementation is a
 * library shipping the component"). A caller names the kind; the organization configured one implementation of it
 * (`resourceImplementations`), and `provision` calls that one.
 */

/** What `provision` answers, whatever the kind: jive-abstract-resource's `EnsureInstanceResult`. */
export type ProvisionResult =
  | { readonly status: "ready"; readonly instanceId: string; readonly instance: unknown }
  | { readonly status: "inProgress"; readonly retryAfterSeconds: number }
  | { readonly status: "personNeeded"; readonly reason: string; readonly url: string }
  | { readonly status: "refused"; readonly reason: string };

/** A provisioning `provision` hands an implementation once the session, organization and kind are resolved. */
export interface ProvisionRequest {
  /** The instance as the caller declared it, unchecked: the implementation validates it against its kind. */
  readonly instance: unknown;
  readonly pipeline: PipelineSession;
  readonly organizationName: string;
}

/** One installed implementation of a resource kind: its package, and how to call its component's standard call. */
export interface ResourceImplementation {
  /** The resource package, as an organization configures it, e.g. "jive-resource-connector-package-registry-npm". */
  readonly packageName: string;
  ensureInstance(ctx: ActionCtx, request: ProvisionRequest): Promise<ProvisionResult>;
}

export interface ResourceKind {
  /** The abstract's kind path: its name without "jive-abstract-resource-". */
  readonly kind: string;
  readonly implementations: ReadonlyArray<ResourceImplementation>;
}

export const RESOURCE_KINDS: ReadonlyArray<ResourceKind> = [
  { kind: "connector-package-registry", implementations: [packageRegistryNpm] },
];

export function resourceKindNamed(kind: string): ResourceKind | undefined {
  return RESOURCE_KINDS.find((candidate) => candidate.kind === kind);
}
