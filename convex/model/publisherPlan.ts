import { Option } from "effect";

/** Which CI workflow a trusted publisher admits, as the package-registry contract names it. */
export interface PublisherClaims {
  readonly provider: "github";
  readonly repository: { readonly owner: string; readonly name: string };
  readonly workflowFile: string;
  readonly environment?: string;
}

export interface ListedPublisher {
  readonly id: string;
  readonly claims: PublisherClaims;
  readonly status: "validated" | "unvalidated";
}

/**
 * How long after Jive registered a publisher it still counts as waiting for its first publish. npm expires one
 * after 2 days (https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry); an hour less
 * leaves the deploy that follows time to publish before it does.
 */
export const PENDING_PUBLISHER_WINDOW_MS = 47 * 60 * 60 * 1000;

/** What provisioning does about the package's trusted publisher for the calling job. */
export type PublisherPlan =
  /** A matching publisher can publish: one already did, or Jive registered it recently enough. */
  | { readonly action: "keep" }
  /** Delete these matching publishers (none, or unvalidated ones that may have expired), then register one. */
  | { readonly action: "register"; readonly removeIds: ReadonlyArray<string> };

/** GitHub owner and repository names are case-insensitive; the workflow file and environment are compared exactly. */
export function sameClaims(a: PublisherClaims, b: PublisherClaims): boolean {
  return a.provider === b.provider
    && a.repository.owner.toLowerCase() === b.repository.owner.toLowerCase()
    && a.repository.name.toLowerCase() === b.repository.name.toLowerCase()
    && a.workflowFile === b.workflowFile
    && a.environment === b.environment;
}

/**
 * Decides from what npm lists and when Jive last registered this publisher. npm never says whether an unvalidated
 * publisher is still waiting or expired, so one is kept only when Jive registered it inside the window; one Jive
 * did not register, or registered too long ago, is replaced, which costs one second-factor answer.
 */
export function planPublisher(input: {
  readonly listed: ReadonlyArray<ListedPublisher>;
  readonly wanted: PublisherClaims;
  readonly maybeRegisteredAt: Option.Option<number>;
  readonly now: number;
}): PublisherPlan {
  const matching = input.listed.filter((publisher) => sameClaims(publisher.claims, input.wanted));
  if (matching.some((publisher) => publisher.status === "validated")) return { action: "keep" };
  const registeredRecently = Option.exists(input.maybeRegisteredAt, (registeredAt) => input.now - registeredAt < PENDING_PUBLISHER_WINDOW_MS);
  if (matching.length > 0 && registeredRecently) return { action: "keep" };
  return { action: "register", removeIds: matching.map((publisher) => publisher.id) };
}
