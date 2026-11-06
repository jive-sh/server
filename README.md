# @jive-sh/server

Jive's central server: a [Convex](https://www.convex.dev) backend holding Jive's core resources (organizations and
their code repositories) and acting on outside systems through the resources it installs. It
extends [`jive-abstract-backend-convex`](https://github.com/jive-sh/jive-abstract-backend-convex), whose hooks
push the functions and publish the generated client. Design: the Jive API v1 design doc
(`packages/@jive-sh/jive/docs/jive_api_v1_design.md` in the chaine monorepo).

So far it does three things: **people sign in** with their `jive.sh` passkey and act through sessions, which a
browser or a program (a CLI, the Jive daemon) holds alike; it **signs with each account's SSH key**, which it holds so
no client has to; and **`provision`**, which a pipeline's deploy job calls, with the session it signed in for, to
make sure a resource instance (an npm package) exists right before it uses it.

## Signing in, and sessions

Every Jive call takes a **session token** (`jive_…`) as its `sessionToken` argument and nothing else (Alex,
2026-10-28: "There's a session token. That's it"). A token is returned once, when its session opens; only its SHA-256
is stored. Alex (2026-11-01): "a session should only be obtainable via human passkey, cicd oidc token exchange, or
jive mints a token and hands it off to a compute provider running an agent workflow". Two of those exist:

| Way in | Session | Opened by | Lasts |
| --- | --- | --- | --- |
| A person's passkey | A person's (`sessions`) | `auth:register`, `auth:signIn`, or `signInRequests:claim` for a program whose request a passkey approved | A day after its last use (below), revocable with `sessions:signOut` |
| A deploy job's GitHub Actions ID token | A code repository's pipeline (`pipelineSessions`) | `pipelineSessions:signIn` (below) | 1 hour, deleted when it expires |

The third, a session Jive mints for a compute provider running an agent workflow, waits on the compute resource kind.
Each table has one function that writes it, `insertAccountSession` (`convex/model/sessions.ts`) and
`insertPipelineSession` (`convex/model/pipelineSessions.ts`), and `test/sessions.test.ts` fails if any other file in
`convex/` inserts a session or calls either from anywhere but the check before it. A function that acts for a person
starts with `resolveSession`, one that acts for a pipeline with `resolvePipelineSession`; neither accepts the other's
token.

**A person's session lasts a day after its last use** (Alex, 2026-11-06: "Let's do session length of a day and then
the each use you talked about extends the expiry to a day after that moment of use"). It ends a day after sign-in, and
every mutation or action that acts with it moves its end to a day after that call: each `ssh:sign` (every commit
signature, push and SSH login through jive's agent), `auth:addPasskeyOptions`, `auth:addPasskey` and
`approvalDevices:enable` and `:disable`. They start with `resolveAndExtendSession` (`convex/model/sessions.ts`).
Queries (`ssh:publicKey`, `accounts:me`, `approvalDevices:list`) cannot write in Convex, so they check the session
without moving its end. There is no upper limit: a session used at least once a day never ends, until it is signed
out. The end a client got at sign-in goes stale with the first use, so `accounts:me` returns the current one as
`sessionExpiresAt`. Pipeline sessions keep their fixed hour. `test/end-to-end.test.ts` runs the rule with the
rest of the path: passkey sign-up, the key, a program's sign-in, `ssh:publicKey`, `ssh:sign` checked by
`ssh-keygen -Y verify`, the end moving, and an ended session refused.

Passkeys use relying party `jive.sh`, so a passkey made on any `*.jive.sh` page (skill-sync's included) works. Two
kinds of origin are accepted: `https://${WEBSITE_DOMAIN}` (`convex/model/webAuthn.ts`), and an Android app's
`android:apk-key-hash:<signing certificate SHA-256, base64url>` when the website's `/.well-known/assetlinks.json`
grants that app `delegate_permission/common.get_login_creds` (`convex/model/androidApps.ts`). The file is read only
for a response claiming an app origin; `@jive-sh/app`'s deploy writes it from the signing keys EAS holds, so it is the
one list of apps allowed to use Jive passkeys. Ceremonies are verified in
actions with `@simplewebauthn/server`; what they record is written by one mutation, so no session exists without
its account and passkey.

| Call | Kind | What it does |
| --- | --- | --- |
| `auth:registrationOptions`, `auth:register` | actions | Create an account (handle derived from a random WebAuthn user id) and its passkey; opens a session |
| `auth:signInOptions`, `auth:signIn` | actions | Usernameless sign-in with any registered passkey; opens a session |
| `auth:addPasskeyOptions`, `auth:addPasskey` | actions | Add a passkey to the signed-in account, with its own WebAuthn user handle, its existing passkeys excluded (a phone whose platform does not sync the account's passkey) |
| `accounts:me` | query | The session's account and passkeys, and when the session ends (`sessionExpiresAt`), or null |
| `sessions:signOut` | mutation | Revokes the presented session |
| `signInRequests:open`, `:describe`, `:claim` | action, query, action | Sign a program in (below) |
| `approvalDevices:enable`, `:disable`, `:list` | mutation, mutation, query | Turn phone approval on or off for a phone's Expo push token, and list the account's phones (below) |

**A program signs in through a sign-in request**, since it holds no passkey: it calls `signInRequests:open` and keeps
the claim secret; the person opens the `loginUrl` it returns (`https://jive.sh/login?request=<id>`) and signs in or
registers there with a passkey, which approves the request; the program then calls `signInRequests:claim` until it
answers `approved` with a session token of its own. There is no confirmation code (Alex, 2026-11-01: "a human just
signs in with the passkey. none of this code bullshit"). A request lasts 10 minutes and
is claimed once. All of it is plain Convex, so a program calls it with `ConvexHttpClient` or
`POST <deployment>/api/action`.

**Phone approval.** Alex (2026-11-01): "once an account is registered someone can enable phone approval such that
authn requests from cli will come to a signed in phone and if i approve on my phone then the session token will be
granted to the requestor". The Jive app on a phone, signed in with the account's passkey, calls
`approvalDevices:enable` with its Expo push token. A program names the account by passing its last session token,
expired or not, as `signInRequests:open({ previousSessionToken })`; a revoked or unknown token names nobody. `open`
then pushes the request to that account's phones through Expo's push service (`approvalDevices:pushSignInRequest`,
scheduled from the same transaction) and answers `approvalDevices`, how many phones it pushes to. Tapping the
notification opens the request in the app, whose passkey ceremony approves it through `auth:signIn`, exactly as the
web page does, and the program's `claim` gets its session. The website keeps working for the same request. A handle
(`jive login --account <handle>`) was rejected as the way to name the account: anyone knowing it could send that
person approval prompts, and one mistaken tap would hand them a session. A phone Expo reports `DeviceNotRegistered`
for is forgotten. `test/phone-approval.test.ts` runs the whole flow against a fake Expo push service and a fake
`assetlinks.json`, with software passkeys for the desktop and the app.

## Signing with the account's SSH key

Alex (2026-11-01): "The ssh key will be saved on the account, and a ssh signing request paired with a session token
would have jive internally load the ssh key and sign the request", and "There's just an ssh sign request. You don't
create keys. You can fetch the public key or sign". Each account has exactly one ed25519 key, held in the
`accountKeys` component; its private key never leaves the server, sealed under `CONNECTION_KEY`.
- **Sign-up:** `auth:register` creates the key before it returns, so an account has it from its first session.
  `seed:accountWithPasskey` schedules the same.
- **Deploy:** `ssh:afterDeploy` (the deploy's after-deploy step) gives any account without a key one.
- **Calls:** `convex/ssh.ts` checks the session and calls the component. These two are the whole public API:

| Call | Kind | What it does |
| --- | --- | --- |
| `ssh:publicKey({ sessionToken })` | query | The account's OpenSSH public key, `{ publicKey: "ssh-ed25519 … <handle>@jive.sh" }` |
| `ssh:sign({ sessionToken, data })` | action | Signs `data` (bytes) and returns `signature` (bytes) in SSH's encoding, `string "ssh-ed25519" \|\| string <64-byte signature>` |

`sign` returns exactly what an SSH agent puts in `SSH_AGENT_SIGN_RESPONSE`, and never reads `data`, so a local agent
holding no key forwards each sign request's data as it arrives: the SSHSIG blob `ssh-keygen -Y sign` builds for a
git commit, or the session-bound blob of an SSH authentication. The public key goes on GitHub as both an
authentication key and a signing key. The agent signs in once through a sign-in request (above) and calls `sign`
with its session token; a revoked or expired session signs nothing, and each signature moves the session's end to a
day later.

## The organization's npm connection

The same component holds one npm connection per organization (connector `npm`) and the P-256 signing passkey
registered on that npm account. The connection is created once, in one of two ways:
- by a person with the organization's npm access, through the browser sign-in `npmSessions:save` runs, naming the
  code repository the connection is for;
- by a deployment admin running `bun run connect-npm` (Scaffolding, below).

`npmSessions` and `signingPasskey` check the Jive session and that repository, then call the component.
`provision` reads the token from `accountKeys.npmConnection.token` and passes it to the npm connector's
`resource.ensureInstance`. How `provision` answers npm's second factor is decided by the auto npm work (Grok's and
Alex's); today a write npm guards answers `personNeeded` with npm's page (below).

## How a pipeline calls it

Alex (2026-11-01): "We have a deploy hook in CI. That should do a `jive login --cicd` then `jive provision` for a given
resource". The deploy job of Jive's reusable pipeline has `id-token: write`. It asks GitHub for an ID token with
audience `https://api.jive.sh`, signs the job in with it, then calls `provision` with the session token, both over
Convex's HTTP API. The contract, which the `jive` CLI codes against, is `@jive-sh/jive`'s
`docs/jive_server_provision_api.md`.

```http
POST <deployment URL>/api/action
Authorization: Bearer <GitHub Actions ID token>

{ "path": "pipelineSessions:signIn", "args": {}, "format": "json" }
```

```http
POST <deployment URL>/api/action

{ "path": "provision", "args": { "sessionToken": "jive_…", "kind": "connector-package-registry", "instance": { "packageName": "@scope/name" } }, "format": "json" }
```

**Signing in.** Convex verifies the ID token itself (`convex/auth.config.ts`: a `customJwt` provider with GitHub's
issuer, RS256, and `applicationID` `https://api.jive.sh`); the key set comes from `GITHUB_ACTIONS_JWKS`, GitHub's
`/.well-known/jwks` in production. `signIn` answers `{ status: "signedIn", sessionToken, expiresAt }` or
`{ status: "refused", reason }`. It checks the job (`convex/model/pipelineCaller.ts`). The token must come from:
- `.github/workflows/pipeline.yml`;
- a push or a manual run;
- a protected branch or tag;
- a GitHub-hosted runner;
- a job that names a GitHub Actions environment;
- a code repository registered with Jive, found by GitHub's immutable `repository_id` and `repository_owner_id`.

The session keeps the repository, the environment and the workflow file, which provisioning acts on.

**`provision`** is the default export of `convex/provision.ts`. So its path is `provision`, and from the typed client
it is `api.provision.default`. It takes `{ sessionToken, kind, instance }` and answers:

| Answer | Meaning |
| --- | --- |
| `{ status: "ready", instanceId, instance }` | The instance exists; publish now, by trusted publishing. |
| `{ status: "inProgress", retryAfterSeconds }` | Another deploy job is provisioning it; ask again after `retryAfterSeconds`. |
| `{ status: "personNeeded", reason, url }` | npm wants a person's second factor on its page `url`. The connector's `resultUrl` stays inside the server. |
| `{ status: "refused", reason }` | Don't publish; `reason` says what to change. |

Any other failure is a function error, and the deploy fails without publishing.

`packages:provision({ sessionToken, registry: "npm", packageName })` is what jive-abstract-library 0.8.0's deploy
calls. It is `provision` for kind `connector-package-registry`, in its older shape: `ready`, `inProgress`, or
`refused`, with `personNeeded` turned into `refused` naming the page. It goes away once callers move to the CLI.

## What `provision` does

1. **Who asks** (`convex/provision.ts`): only a live pipeline session may provision. A person's session, or a token
   that opens none, is refused.
2. **Which implementation:** the caller names the kind, never the implementation (Alex, 2026-11-01: "it should
   probably only be provisioning the abstract. so `jive provision connector-package-registry` and then it talks to
   the jive org which should have one impl configured"). The session's organization configures one implementation
   per kind (`resourceImplementations`). `convex/model/resourceKinds.ts` lists the kinds and the implementations this
   server installed: `connector-package-registry`, with `jive-resource-connector-package-registry-npm`. These are
   refused, each with the organization and the kind named:
   - an unknown kind;
   - an organization with no implementation configured for the kind;
   - a configured implementation this server didn't install.
3. **The implementation's standard call** (`convex/model/packageRegistryNpm.ts` for npm): it checks the instance is
   `{ packageName }`, reads the organization's npm token from `accountKeys` (refusing an organization with none),
   and calls `packageRegistryNpm`'s `resource.ensureInstance`. That call does the work, in the connector:
   - binds the package to the code repository that first provisioned it;
   - claims it, so two deploy jobs don't act at once;
   - creates the `0.0.0` placeholder if it's missing;
   - keeps or replaces the trusted publisher for the repository, `pipeline.yml` and the environment;
   - records the package in its own tables.

   Its README has the details.

npm asks for the account's second factor before publishing the placeholder or changing trusted publishers. The
connector never answers it: it hands back npm's own page, where a person answers, so `provision` answers
`personNeeded`. A provisioning that needs no write (the package exists and its publisher for the job has published)
answers `ready`.

## Records

`convex/schema.ts`: `accounts`, `passkeys`, `webAuthnChallenges`, `sessions`, `pipelineSessions`,
`signInRequests`, `organizations`, `connectionRequests`, `codeRepositories`, `resourceImplementations`. Other
components hold the rest:
- `accountKeys` holds SSH keys, npm connections and signing passkeys.
- The npm connector holds each provisioned package and its claims.

Challenges, sign-in requests and pipeline sessions are deleted by a scheduled function when they expire.

A credential (for npm: the token) is stored sealed, never in the clear: AES-256-GCM under `CONNECTION_KEY`, as
`<nonce>.<ciphertext>` beside the key's version (`convex/model/sealing.ts`). `CONNECTION_KEY` is
`<version>:<base64 32 bytes>`, generated once per deployment by the backend abstract.

## Scaffolding

Until `organizations.create`, `codeRepositories.provision` and a CLI call that creates a connection exist, a
deployment admin registers them by hand.

The organization and its repository, by GitHub's ids (none of it secret):

```sh
bunx convex run seed:organizationWithRepository '{"organizationName":"…","repository":{"repositoryId":"…","repositoryOwnerId":"…","owner":"…","name":"…"}}' --deployment <deployment>
```

The implementation the organization uses for a resource kind (one per kind):

```sh
bunx convex run seed:resourceImplementation '{"organizationName":"…","kind":"connector-package-registry","implementation":"jive-resource-connector-package-registry-npm"}' --deployment <deployment>
```

The npm connection, so that the token is never on a command line or in shell history:

```sh
bun run connect-npm -- --deployment <deployment> --organization <organization>
```

It prompts for the npm access token without echoing it, and checks the token with npm's read-only `/-/whoami`; it
never sends a one-time password to npm. It then has `convex run connections:openNpmConnectionRequest`
issue a single-use request id, valid for 5 minutes and stored only as its SHA-256, and sends the credential with
that id to the public action `connections:completeNpmConnection` in an HTTPS body. That action stores the token in
`accountKeys`, sealed, replacing any npm connection the organization had, and spends the id.

Alex's account was made by `seed:accountWithPasskey` (once, on production, 2026-11-01) from the passkey
skill-sync-service holds in its `credentials` table, copied, not moved, so skill-sync keeps it too.

## Verification

`bun run jive:cicd:audit` typechecks and runs:

- `test/model.test.ts`: the pipeline sign-in checks and sealing.
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
- `test/provision.test.ts`, on an anonymous local Convex backend (no Convex account):
  - **Setup:** the npm connection is made by running `connect-npm` with the token piped in.
  - **`pipelineSessions:signIn`**, called over HTTP with RS256 tokens shaped like GitHub's and signed by a key the
    test generates:
    - refused: no token, a wrong audience or key, an unregistered repository, a pull request, and a job outside an
      environment;
    - a deploy job's session token lasts an hour, is stored only as its hash, and has its deletion scheduled at
      expiry.
  - **`provision`, by its bare path**, against a fake npm registry that guards every write with npm's web
    second-factor challenge:
    - refused: a made-up token, a person's session, a deleted pipeline session, an unknown kind, an instance that
      isn't `{ packageName }`, an organization with no implementation configured, one with no npm connection, and
      another repository asking for the same package;
    - a pipeline's token is refused by a person's call;
    - a new package answers `personNeeded` with npm's page and publishes nothing;
    - a provisioned package is `ready` with no write, with the same `instanceId` on every call;
    - a held claim answers `inProgress`;
    - `packages:provision` gives the same answers in its older shape.
  - **Also:** an uninstalled implementation can't be configured, a connection request works once, and the stored
    token is sealed in `accountKeys`.

## Not built yet

- The other resources' calls, organization membership, and a GitHub connection (design doc §3, §7).
- The third way to a session: one Jive mints for a compute provider running an agent workflow, which waits on the
  compute resource kind.
- The local SSH agent that forwards sign requests to `ssh:sign` (the client side; ozy-cli's signing agent still
  derives its key on the machine).
- Provisioning its own client package through Jive. Production is the deployment `adventurous-viper-740` (project
  `jive-server`, reference `latest`), served at `https://api.jive.sh`, the custom domain the deploy registers
  (`customDomains`, canonical for the Convex client API). The pipeline reaches it with the team access token
  (`CONVEX_TEAM_ACCESS_TOKEN`), since only the Management API adds custom domains; until 0.8.0 it used a production
  deploy key (design doc §11). The client `@jive-sh/server-client` is published with the `NPM_TOKEN` repository secret and
  `backend-convex.provisionWithJive: null`, without trusted publishing, until the npm connector can answer npm's
  second factor (Alex, 2026-10-31: "rely on npm tokens with no trusted publishing until Grok's work on a cloud based
  security key embedded in the npm connector is done").
