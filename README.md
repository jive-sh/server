# @jive-sh/server

Jive's central server: a [Convex](https://www.convex.dev) backend holding Jive's core resources (organizations,
code repositories, connections, packages) and acting on outside systems through connectors it installs. It
extends [`jive-abstract-backend-convex`](https://github.com/jive-sh/jive-abstract-backend-convex), whose hooks
push the functions and publish the generated client. Design: the Jive API v1 design doc
(`packages/@jive-sh/jive/docs/jive_api_v1_design.md` in the chaine monorepo).

So far it does three things: **people sign in** with their `jive.sh` passkey and act through sessions, which a
browser or a program (a CLI, the Jive daemon) holds alike; it **signs with each account's SSH key**, which it holds so
no client has to; and **`packages:provision`**, which a pipeline's deploy job calls, with the session it signed in
for, right before it publishes a package to npm.

## Signing in, and sessions

Every Jive call takes a **session token** (`jive_…`) as its `sessionToken` argument and nothing else (Alex,
2026-10-28: "There's a session token. That's it"). A token is returned once, when its session opens; only its SHA-256
is stored. Alex (2026-11-01): "a session should only be obtainable via human passkey, cicd oidc token exchange, or
jive mints a token and hands it off to a compute provider running an agent workflow". Two of those exist:

| Way in | Session | Opened by | Lasts |
| --- | --- | --- | --- |
| A person's passkey | A person's (`sessions`) | `auth:register`, `auth:signIn`, or `signInRequests:claim` for a program whose request a passkey approved | 12 hours, revocable with `sessions:signOut` |
| A deploy job's GitHub Actions ID token | A code repository's pipeline (`pipelineSessions`) | `pipelineSessions:signIn` (below) | 1 hour, deleted when it expires |

The third, a session Jive mints for a compute provider running an agent workflow, waits on the compute resource kind.
Each table has one function that writes it, `insertAccountSession` (`convex/model/sessions.ts`) and
`insertPipelineSession` (`convex/model/pipelineSessions.ts`), and `test/sessions.test.ts` fails if any other file in
`convex/` inserts a session or calls either from anywhere but the check before it. A function that acts for a person
starts with `resolveSession`, one that acts for a pipeline with `resolvePipelineSession`; neither accepts the other's
token.

Passkeys use relying party `jive.sh`, so a passkey made on any `*.jive.sh` page (skill-sync's included) works, and
the only accepted origin is `https://${WEBSITE_DOMAIN}` (`convex/model/webAuthn.ts`). Ceremonies are verified in
actions with `@simplewebauthn/server`; what they record is written by one mutation, so no session exists without
its account and passkey.

| Call | Kind | What it does |
| --- | --- | --- |
| `auth:registrationOptions`, `auth:register` | actions | Create an account (handle derived from a random WebAuthn user id) and its passkey; opens a session |
| `auth:signInOptions`, `auth:signIn` | actions | Usernameless sign-in with any registered passkey; opens a session |
| `accounts:me` | query | The session's account and passkeys, or null |
| `sessions:signOut` | mutation | Revokes the presented session |
| `signInRequests:open`, `:describe`, `:claim` | action, query, action | Sign a program in (below) |

**A program signs in through a sign-in request**, since it holds no passkey: it calls `signInRequests:open` and keeps
the claim secret; the person opens the `loginUrl` it returns (`https://jive.sh/login?request=<id>`), checks the
confirmation code matches, and signs in or registers there, which approves the request; the program then calls
`signInRequests:claim` until it answers `approved` with a session token of its own. A request lasts 10 minutes and
is claimed once. All of it is plain Convex, so a program calls it with `ConvexHttpClient` or
`POST <deployment>/api/action`.

## Signing with the account's SSH key

Alex (2026-11-01): "The ssh key will be saved on the account, and a ssh signing request paired with a session token
would have jive internally load the ssh key and sign the request". Each account has at most one ed25519 key,
generated in the `accountKeys` component; its private key never leaves the server, sealed under `CONNECTION_KEY`.
`convex/ssh.ts` checks the session and calls the component. The calls below are unchanged.

| Call | Kind | What it does |
| --- | --- | --- |
| `ssh:createKey({ sessionToken })` | action | Creates the account's key on the first call; returns its OpenSSH public key (`ssh-ed25519 … <handle>@jive.sh`) every time |
| `ssh:publicKey({ sessionToken })` | query | The public key, or null before `createKey` |
| `ssh:sign({ sessionToken, data })` | action | Signs `data` (bytes) and returns `signature` (bytes) in SSH's encoding, `string "ssh-ed25519" \|\| string <64-byte signature>` |

`sign` returns exactly what an SSH agent puts in `SSH_AGENT_SIGN_RESPONSE`, and never reads `data`, so a local agent
holding no key forwards each sign request's data as it arrives: the SSHSIG blob `ssh-keygen -Y sign` builds for a
git commit, or the session-bound blob of an SSH authentication. The public key goes on GitHub as both an
authentication key and a signing key. The agent signs in once through a sign-in request (above) and calls `sign`
with its session token; a revoked or expired session signs nothing.

## The organization's npm connection

The same component holds one npm connection per organization (connector `npm`) and the P-256 signing passkey
registered on that npm account. A person with the organization's npm access creates the connection once, through
the browser sign-in `npmSessions:save` runs, naming the code repository the connection is for. `npmSessions` and
`signingPasskey` check the Jive session and that repository, then call the component. `provision` (the default
export of `convex/provision.ts`) reads the token and the passkey assertion from `accountKeys.npmConnection.token`
and `accountKeys.npmConnection.sign`, and passes the token to the npm connector's `resource.ensureInstance`
(see `@jive-sh/jive`'s `docs/jive_server_provision_api.md`). `packages:provision` still reads the app `connections`
table until that call lands.

## How a pipeline calls it

The deploy job of Jive's reusable pipeline has `id-token: write`. `jive-abstract-library` (0.8.0+, with
`jive.library.provisionWithJive: { "serverUrl": … }`) asks GitHub for an ID token with audience
`https://api.jive.sh`, signs the job in with it, then calls `packages:provision` with the session token, both over
Convex's HTTP API:

```http
POST <deployment URL>/api/action
Authorization: Bearer <GitHub Actions ID token>

{ "path": "pipelineSessions:signIn", "args": {}, "format": "json" }
```

```http
POST <deployment URL>/api/action

{ "path": "packages:provision", "args": { "sessionToken": "jive_…", "registry": "npm", "packageName": "@scope/name" }, "format": "json" }
```

Convex verifies the ID token itself (`convex/auth.config.ts`: a `customJwt` provider with GitHub's issuer, RS256,
and `applicationID` `https://api.jive.sh`); the key set comes from `GITHUB_ACTIONS_JWKS`, GitHub's
`/.well-known/jwks` in production. `signIn` answers `{ status: "signedIn", sessionToken, expiresAt }` or
`{ status: "refused", reason }`. It checks the job (`convex/model/pipelineCaller.ts`): the token must come from
`.github/workflows/pipeline.yml`, from a push or a manual run, on a protected branch or tag, on a GitHub-hosted
runner, in a job that names a GitHub Actions environment, of a code repository registered with Jive, found by
GitHub's immutable `repository_id` and `repository_owner_id`. The session keeps the repository, the environment and
the workflow file, which provisioning acts on. `packages:provision` answers one of:

| Answer | Meaning |
| --- | --- |
| `{ status: "ready" }` | Publish now, by trusted publishing. |
| `{ status: "inProgress" }` | Another deploy job is provisioning this package; ask again shortly. |
| `{ status: "refused", reason }` | Don't publish; `reason` says what to change. A token that opens no live pipeline session is refused. |

Any other failure is a function error, and the deploy fails without publishing.

## What `packages:provision` does

1. **For which repository:** the pipeline session's. A package already bound to another repository is refused.
2. **One at a time:** a mutation claims the package (`provisioningClaims`), so of two deploy jobs only one acts;
   the other gets `inProgress`. A claim lasts 5 minutes, so one left by a dead action is taken over.
3. **Through the organization's npm connection** (`jive-resource-connector-package-registry-npm`): create the `0.0.0`
   placeholder if the package doesn't exist (refusing a package another npm account maintains); then make sure a
   trusted publisher for the repository, `pipeline.yml` and the job's environment can publish. A validated one,
   or one Jive registered less than 47 hours ago, is kept; an unvalidated one that is older or unknown to Jive may
   have expired (npm expires a publisher unused for 2 days and doesn't say so), so it is removed and registered
   again (`convex/model/publisherPlan.ts`).
4. Record the package, its repository and when each environment's publisher was registered; release the claim.

npm asks for the account's second factor before publishing the placeholder or changing trusted publishers. The
connector never answers it: it hands back npm's own page, where a person answers. Nothing passes that answer back to
npm yet, so a provisioning that needs a write answers `refused`, its reason naming the page; one that needs none (the
package exists and its publisher has published) answers `ready`. The connection holds only the npm token
(`bun run connect-npm`); a connection stored before 0.2.0 also holds an authenticator secret, which nothing reads.

## Records

`convex/schema.ts`: `accounts`, `passkeys`, `webAuthnChallenges`, `sessions`, `pipelineSessions`,
`signInRequests`, `organizations`, `connections`, `codeRepositories`, `packages`, `provisioningClaims`. SSH keys,
npm connections and signing passkeys are the `accountKeys` component's tables. Challenges,
sign-in requests and pipeline sessions are deleted by a scheduled function when they expire.

A connection's credential (for npm: the token) is stored sealed, never in the
clear: AES-256-GCM under `CONNECTION_KEY`, as `<nonce>.<ciphertext>` beside the key's version, the way
`@jive-sh/app`'s Cloudflare backend did (`convex/model/sealing.ts`). `CONNECTION_KEY` is `<version>:<base64 32 bytes>`,
generated once per deployment by the backend abstract. Only internal functions read a connection, and only the
provisioning action opens one.

## Scaffolding

Until `organizations.create`, `codeRepositories.provision` and `connections.create` exist, a person registers
them by hand.

The organization and its repository, by GitHub's ids (none of it secret):

```sh
bunx convex run seed:organizationWithRepository '{"organizationName":"…","repository":{"repositoryId":"…","repositoryOwnerId":"…","owner":"…","name":"…"}}' --deployment <deployment>
```

The npm connection, so that the token is never on a command line or in shell history:

```sh
bun run connect-npm -- --deployment <deployment> --organization <organization>
```

It prompts for the npm access token without echoing it, and checks the token with npm's read-only `/-/whoami`; it
never sends a one-time password to npm. It then has `convex run connections:openNpmConnectionRequest`
issue a single-use request id, valid for 5 minutes and stored only as its SHA-256, and sends the credential with
that id to the public action `connections:completeNpmConnection` in an HTTPS body. That action stores the credential
sealed, replacing any npm connection the organization had, and spends the id.

Alex's account was made by `seed:accountWithPasskey` (once, on production, 2026-11-01) from the passkey
skill-sync-service holds in its `credentials` table, copied, not moved, so skill-sync keeps it too.

## Verification

`bun run jive:cicd:audit` typechecks and runs:

- `test/model.test.ts`: the pipeline sign-in checks, the publisher decisions, sealing, and the provisioning flow
  against in-memory records and connector.
- `test/sessions.test.ts`: only `insertAccountSession` and `insertPipelineSession` insert sessions, and each is called
  only after its check.
- `test/connect-npm.test.ts`: the hidden prompt's line handling.
- `test/auth.test.ts`: registration, sign-in, sign-out, an imported passkey, and a program's sign-in request, on the
  local backend through `ConvexHttpClient`, with a software passkey (`test/support/softwareAuthenticator.ts`) whose
  real WebAuthn responses `@simplewebauthn/server` verifies; a wrong origin, a reused challenge and an unknown
  passkey are refused.
- `test/ssh.test.ts`: a signed-in account's key is created once, read by `ssh-keygen -l` as ED25519, and stored
  sealed; a git commit signature assembled from `ssh:sign` the way `ssh-keygen -Y sign` assembles one over an
  agent passes the real `ssh-keygen -Y verify` (and fails for another commit); an SSH authentication blob's
  signature verifies against the public key; a made-up or revoked session, and an account with no key, are refused.
- `test/provision.test.ts`: the package pushed to an anonymous local Convex backend (no Convex account); the npm
  connection made by running `connect-npm` with the token piped in; `pipelineSessions:signIn` called over HTTP with
  RS256 tokens shaped like GitHub's and signed by a key the test generates: no token, a wrong audience or key, an
  unregistered repository, a pull request and a job outside an environment refused; a deploy job's session token
  lasting an hour, stored only as its hash, its deletion scheduled at expiry. Then `packages:provision` with that
  session, against a fake npm registry that guards every write with npm's web second-factor challenge: a made-up
  token, a person's session and a deleted pipeline session refused; a pipeline's token refused by a person's call;
  a new package refused with npm's page, a provisioned package ready with no write, a repeated call changing
  nothing, a held claim, another repository refused, a connection request used twice, and that the stored
  credential is sealed.

## Not built yet

- The other resources' calls, organization membership, and a GitHub connection (design doc §3, §7).
- The third way to a session: one Jive mints for a compute provider running an agent workflow, which waits on the
  compute resource kind.
- The local SSH agent that forwards sign requests to `ssh:sign` (the client side; ozy-cli's signing agent still
  derives its key on the machine).
- `api.jive.sh` as the deployment's domain: it still serves `@jive-sh/app`'s Worker.
- Provisioning its own client package through Jive. Production is the deployment `adventurous-viper-740` (project
  `jive-server`, reference `latest`), which the pipeline reaches with a production deploy key (`CONVEX_DEPLOY_KEY`,
  design doc §11) allowed only `deployment:deploy`, `deployment:env:view`, `deployment:env:write` and the
  `runInternal*` actions. The client `@jive-sh/server-client` is published with the `NPM_TOKEN` repository secret and
  `backend-convex.provisionWithJive: null`, without trusted publishing, until the npm connector can answer npm's
  second factor (Alex, 2026-10-31: "rely on npm tokens with no trusted publishing until Grok's work on a cloud based
  security key embedded in the npm connector is done").
