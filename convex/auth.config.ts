import { GITHUB_ACTIONS_ISSUER, JIVE_API_AUDIENCE } from "./model/githubActions";

/**
 * Pipelines sign in with their GitHub Actions ID token (design doc §4a). GitHub serves its keys at
 * `/.well-known/jwks`, not the `/.well-known/jwks.json` Convex's plain OIDC provider expects, hence `customJwt`.
 * The key set comes from `GITHUB_ACTIONS_JWKS` (GitHub's URL in production, set by the manifest) so tests can
 * sign tokens of their own against a local backend.
 */
export default {
  providers: [
    {
      type: "customJwt",
      issuer: GITHUB_ACTIONS_ISSUER,
      jwks: process.env.GITHUB_ACTIONS_JWKS!,
      algorithm: "RS256",
      applicationID: JIVE_API_AUDIENCE,
    },
  ],
};
