/**
 * GitHub Actions' OIDC issuer (https://token.actions.githubusercontent.com/.well-known/openid-configuration),
 * which `auth.config.ts` trusts and every function checks a caller's identity against.
 */
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * The audience a pipeline asks GitHub for when it calls Jive: it names Jive's API, not where a deployment is
 * reached, and Convex checks it against the token's `aud`. jive-abstract-library requests the same value.
 */
export const JIVE_API_AUDIENCE = "https://api.jive.sh";
