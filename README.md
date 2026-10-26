# @jive-sh/server

Jive's central server: a [Convex](https://www.convex.dev) backend holding Jive's core resources (organizations,
code repositories, connections, packages) and acting on outside systems through connectors it installs. It
extends [`jive-abstract-backend-convex`](https://github.com/jive-sh/jive-abstract-backend-convex), whose hooks
push the functions and publish the generated client. Design: the Jive API v1 design doc
(`jive_api_v1_design.md` beside this package in the chaine monorepo).

So far it does one thing: **`packages:provision`**, which a pipeline's deploy job calls right before it publishes
a package to npm.

## How a pipeline calls it

The deploy job of Jive's reusable pipeline has `id-token: write`. `jive-abstract-library` (0.3.0+, with
`jive.library.provisionWithJive: { "serverUrl": … }`) asks GitHub for an ID token with audience
`https://api.jive.sh` and calls the action over Convex's HTTP API:

```http
POST <deployment URL>/api/action
Authorization: Bearer <GitHub Actions ID token>

{ "path": "packages:provision", "args": { "registry": "npm", "packageName": "@scope/name" }, "format": "json" }
```

Convex verifies the token itself (`convex/auth.config.ts`: a `customJwt` provider with GitHub's issuer, RS256,
and `applicationID` `https://api.jive.sh`); the key set comes from `GITHUB_ACTIONS_JWKS`, GitHub's
`/.well-known/jwks` in production. The answer is one of:

| Answer | Meaning |
| --- | --- |
| `{ status: "ready" }` | Publish now, by trusted publishing. |
| `{ status: "inProgress" }` | Another deploy job is provisioning this package; ask again shortly. |
| `{ status: "refused", reason }` | Don't publish; `reason` says what to change. |

Any other failure is a function error, and the deploy fails without publishing.

## What `packages:provision` does

1. **Who is calling** (`convex/model/pipelineCaller.ts`): the token must come from `.github/workflows/pipeline.yml`,
   from a push or a manual run, on a protected branch or tag, on a GitHub-hosted runner, in a job that names a
   GitHub Actions environment. The repository is found by GitHub's immutable `repository_id` and
   `repository_owner_id`; an unregistered one is refused. A package already bound to another repository is
   refused.
2. **One at a time:** a mutation claims the package (`provisioningClaims`), so of two deploy jobs only one acts;
   the other gets `inProgress`. A claim lasts 5 minutes, so one left by a dead action is taken over.
3. **Through the organization's npm connection** (`jive-connector-package-registry-npm`): create the `0.0.0`
   placeholder if the package doesn't exist (refusing a package another npm account maintains); then make sure a
   trusted publisher for the repository, `pipeline.yml` and the job's environment can publish. A validated one,
   or one Jive registered less than 47 hours ago, is kept; an unvalidated one that is older or unknown to Jive may
   have expired (npm expires a publisher unused for 2 days and doesn't say so), so it is removed and registered
   again (`convex/model/publisherPlan.ts`).
4. Record the package, its repository and when each environment's publisher was registered; release the claim.

npm asks for the account's second factor before publishing the placeholder or changing trusted publishers; the
connector answers with the current code from the account's authenticator-app (TOTP) secret.

## Records

`convex/schema.ts`: `organizations`, `connections`, `codeRepositories`, `packages`, `provisioningClaims`.

A connection's credential (for npm: the token and the authenticator-app secret) is stored sealed, never in the
clear: AES-256-GCM under `CONNECTION_KEY`, as `<nonce>.<ciphertext>` beside the key's version, the way
`@jive-sh/app` seals connections (`convex/model/sealing.ts`). `CONNECTION_KEY` is `<version>:<base64 32 bytes>`,
generated once per deployment by the backend abstract. Only internal functions read a connection, and only the
provisioning action opens one.

## Scaffolding

Until `organizations.create`, `codeRepositories.provision` and `connections.create` exist, a person registers
them by hand.

The organization and its repository, by GitHub's ids (none of it secret):

```sh
bunx convex run seed:organizationWithRepository '{"organizationName":"…","repository":{"repositoryId":"…","repositoryOwnerId":"…","owner":"…","name":"…"}}' --deployment <deployment>
```

The npm connection, so that neither the token nor the authenticator secret is ever on a command line or in shell
history:

```sh
bun run connect-npm -- --deployment <deployment> --organization <organization>
```

It prompts for the npm access token and the authenticator setup secret (the base32 text, or the whole
`otpauth://` URL from npm's QR code) without echoing either, and checks the token with npm's read-only
`/-/whoami`; it never sends a one-time password to npm. It then has `convex run connections:openNpmConnectionRequest`
issue a single-use request id, valid for 5 minutes and stored only as its SHA-256, and sends the credential with
that id to the public action `connections:completeNpmConnection` in an HTTPS body. That action stores the credential
sealed, replacing any npm connection the organization had, and spends the id.

## Verification

`bun run jive:cicd:audit` typechecks and runs:

- `test/model.test.ts`: the caller checks, the publisher decisions, sealing, and the provisioning flow against
  in-memory records and connector.
- `test/connect-npm.test.ts`: reading the authenticator secret (base32 or `otpauth://` URL, refusing what the
  connector can't use) and the prompts' line handling.
- `test/provision.test.ts`: the package pushed to an anonymous local Convex backend (no Convex account); the npm
  connection made by running `connect-npm` with its answers piped in; `packages:provision` called over HTTP with
  RS256 tokens shaped like GitHub's and signed by a key the test generates, against a fake npm registry that
  demands a TOTP code: a new package, a repeated call changing nothing, a held claim, refusals, a connection
  request used twice, and that the stored credential is sealed.

## Not built yet

- The other resources' calls, people signing in, and a GitHub connection (design doc §3, §7).
- `api.jive.sh` as the deployment's domain: it still serves `@jive-sh/app`'s Worker.
- Deploying through this package's own pipeline: its first push to `main` deploys production and publishes its
  client to npm, so it waits for that go-ahead.
