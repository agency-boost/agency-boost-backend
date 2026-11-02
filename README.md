# agency-boost-backend

NestJS API for AgencyBoost, a multi-tenant SaaS for insurance agency offices (KPM).

**This repository is a submodule of the `agency-boost` superproject** (ADR-0009). It is a complete,
independent repository — branch, commit and push here normally.

The documentation that governs it lives in the superproject, one level up as `../docs/`, with the
working rules in `../.claude/`. Start at
[`../CLAUDE.md`](../CLAUDE.md) and [`backend/CLAUDE.md`](CLAUDE.md).

## Stack

NestJS · MongoDB (Mongoose) · Google Cloud Storage · Jest · Docker · GitHub Actions · Google Compute
Engine (one VM for staging and production, ADR-0155)

## Setup

Node **24** and pnpm **10.33** (`package.json#packageManager`; `npm i -g pnpm@10.33.0`), and a MongoDB
7.0 to point at, a local `mongod` or one in Docker. See
[`../docs/03-engineering/local-development.md`](../docs/03-engineering/local-development.md). In short:

```bash
pnpm install
cp .env.example .env      # keys documented in ../docs/03-engineering/environments-and-configuration.md
pnpm seed:demo
pnpm dev                  # http://localhost:3001, OpenAPI at /api/docs
```

**File storage is off by default locally** (plan decision D12, ADR-0153). With `GCS_BUCKET` empty the API
boots, and every upload and file link answers `503 STORAGE_NOT_CONFIGURED`; `seed:demo` skips its
demonstration PDFs. To work on uploads, point `GCS_BUCKET` at the dev bucket and sign in as the dev
signer with `gcloud auth application-default login --impersonate-service-account=…`, as `.env.example`
describes. There is no key file anywhere.

## The rules that bite here

- **Never commit from Claude** — it proposes a message; a human commits.
- **Queries go through `TenantScopedRepository`.** A service injecting a Mongoose model directly is a
  defect, even when the query is correct.
- **`membershipId` is the foreign key** on per-user data — never `userId`, never a name.
- **404, not 403**, for a resource in another tenant.
- Money in integer minor units; day boundaries in the tenant timezone.

Full list: `../.claude/rules/domain-invariants.md`.

## Working as a submodule

Day-to-day development is unchanged. The one addition: after pushing here, the superproject needs a
**pointer bump** so it records which commit of this repository belongs with the current docs.

```bash
# here
git commit -m "feat(...): …" && git push

# in the superproject
cd .. && git add backend && git commit -m "chore(backend): bump pointer to <sha>"
```

Merge the PR here first, then the superproject bump — a pointer to a commit that only exists on a
deleted feature branch breaks every fresh clone.

## Deployment

**Staging and production share one VM** in one Google Cloud project while production is dark
([ADR-0155](../docs/04-adr/0155-staging-and-production-share-one-vm-while-production-is-dark.md), which
supersedes [ADR-0152](../docs/04-adr/0152-staging-and-production-run-on-gcp-vms-with-mongodb-on-its-own-disk.md)
in part). On it, Docker Compose runs Caddy, one API per environment, and one MongoDB whose data sits on
its own disk. Files are in Cloud Storage
([ADR-0153](../docs/04-adr/0153-google-cloud-storage-replaces-cloudinary.md)), the frontend is on Vercel,
and branches map to environments per
[ADR-0154](../docs/04-adr/0154-development-is-staging-and-main-is-production.md). The operator's
runbook is [`../docs/03-engineering/deployment-gcp.md`](../docs/03-engineering/deployment-gcp.md).

```
 https://staging.agencyboost.id (Vercel) ─┐     https://agencyboost.id (Vercel) ─┐
                                          ▼                                      ▼
 https://staging-api.agencyboost.id ─┐            https://api.agencyboost.id ─┐
                                     ▼                                         ▼
 VM agencyboost-backend (e2-small, 2 GB, Ubuntu 26.04), asia-southeast2-b, project project-2bac9fc9-f453-47b4-a29
   Docker Compose, one project
     caddy :80/:443            two sites, TLS from Let's Encrypt, HSTS, 30 MB bodies          128m
       ├▶ api-staging :3001    NODE_ENV=staging,    database agencyboost_staging              512m
       └▶ api-prod    :3001    NODE_ENV=production, database agencyboost                      512m
            └▶ mongo           127.0.0.1:27017 only; one user per database, readWrite on it   700m
   boot disk   20 GB
   data disk   mongodb, 10 GB, at /mnt/mongo-data   snapshots every 4 h, kept 14 days
   identity    api-runtime (scope cloud-platform), shared by both APIs
 ├─ gs://agencyboost-staging-assets, gs://agencyboost-prod-assets   private; uploads by signed POST
 ├─ gs://agencyboost-backups   prefixes staging/ (7 days) and prod/ (30 days); the VM may add, never delete
 ├─ Secret Manager   api-env-staging, api-env-prod, mongo-root
 └─ Artifact Registry   agencyboost-staging, agencyboost-prod; immutable tags; each written by its own builder

 GitHub Actions ──WIF──▶ gh-builder-<env>: build, push ──▶ gh-deployer-<env>: IAP SSH ──▶ sudo deploy.sh <env> <image@digest>
```

### Environments and branches

| | Branch | API | App (Vercel) | Service on the VM | Database | Registry | Secret |
|---|---|---|---|---|---|---|---|
| **Staging** | `development` | `staging-api.agencyboost.id` | `staging.agencyboost.id` | `api-staging` | `agencyboost_staging` | `agencyboost-staging` | `api-env-staging` |
| **Production** | `main` | `api.agencyboost.id` | `agencyboost.id` | `api-prod` | `agencyboost` | `agencyboost-prod` | `api-env-prod` |

A push to `development` deploys staging. A push to `main`, which arrives through an approved release PR
from `development`, deploys production. There are no per-PR environments. **Release the backend first**,
then promote the frontend on Vercel (`../frontend/README.md`). Production starts **dark**, with no tenant
and no seed, until P19-T7 (D11).

All four hosts share the site `agencyboost.id`, so the refresh cookie stays `SameSite=Lax`
(`COOKIE_CROSS_SITE=false`). Each API accepts its own app's origin and no other, the sibling
environment's included.

### What keeps the two apart on one VM, and what does not

What does:
- Each environment has its own API container and env file.
- Each has its own database, reached by **its own MongoDB user, holding `readWrite` on that database
  and nothing else**. `deploy.sh` and `seed.sh` ask Mongo for that user's roles before every deploy
  and seed, and refuse anything wider. The staging seed's `--reset` therefore cannot touch production's
  database; the stand-in test proves it.
- Each has its own bucket, registry and Caddy site.
- Each has its own GitHub identities: the staging deployer may run only `deploy.sh staging …` and
  `seed.sh staging …`, and the production deployer only `deploy.sh prod …`.

**What does not — an accepted risk, recorded in ADR-0155**:
- Both APIs run as the same VM identity, `api-runtime`. Through it the staging API can read
  production's secret and bucket.
- A staging deploy installs `deploy/`'s scripts as root, so whoever can push to `development` can reach
  production on this VM.
- One Mongo and one VM mean one outage takes both down.

This is acceptable only while production holds no real data
(`../docs/02-specs/nfr/security-and-privacy.md`). **Before real tenants (P19-T7), production moves to a
VM of its own**, the original ADR-0152 shape, or that isolation is built.

### Memory

An e2-small has 2 GB. `compose.yml` holds every service to a budget:
- MongoDB: 700m, with a 0.25 GB WiredTiger cache;
- each API: 512m, with `NODE_OPTIONS=--max-old-space-size=384`;
- Caddy: 128m.

`bootstrap.sh` adds 2 GB of swap, which a migration or a seed running beside both APIs leans on.
Resize to **e2-medium** before P19-T7, or sooner if the staging seed runs out of memory.

### What `deploy.yml` does

On a push to `development` or `main`, or by hand from that branch (`workflow_dispatch`):

1. **`target`** — `development` → `staging` and `main` → `production` (on the VM: `staging`, `prod`). A
   manual run must name the environment its branch deploys.
2. **`ci`** — the whole of `ci.yml` (below). Nothing after it runs unless it is green.
3. **`build`** — authenticates through Workload Identity Federation as **`gh-builder-<env>`**, which may
   push to that environment's repository and do nothing else. It authenticates with a bare access token,
   so no credentials file is ever written where `COPY . .` could carry it into an image. It builds the
   `runtime` stage and pushes it to `asia-southeast2-docker.pkg.dev/<GCP_PROJECT_ID>/agencyboost-<env>/api`,
   tagged `<commit>-<run id>-<attempt>`.
   - **Every run builds; nothing is reused.** Production builds from the `main` commit with no build
     cache imported.
   - Tags are immutable, and this one is unique per build.
4. **`deploy`** — in the GitHub environment, as **`gh-deployer-<env>`**, one at a time per environment and
   never cancelled halfway.
   - **It deploys only if its commit is still the head of the branch.** A re-run always deploys, because
     that is the rollback.
   - A production deploy first snapshots the data disk `mongodb`, which holds both databases; a staging
     deploy takes no snapshot.
   - Then `deploy/` is copied to the VM over IAP, and `sudo /opt/agencyboost/bin/deploy.sh <env> --bundle …
     <image@digest>` runs there, as a systemd unit of its own whose journal the job follows. A dropped
     SSH session never stops a deploy.

   The unit:
   - takes the VM-wide lock, which deploys of both environments, the seed and the backup share;
   - refuses to run unless `/mnt/mongo-data` is mounted and carries the sentinel file;
   - installs the new `compose.yml`, `Caddyfile`, scripts and units, and has Caddy validate a changed
     Caddyfile;
   - renders `env/api-<env>.env` from `api-env-<env>`. It refuses one whose `NODE_ENV` or
     `MONGODB_DB_NAME` belongs to the other environment, or one with a `<placeholder>` left in it. On the
     very first deploy it renders `mongo-root` too, and refuses it without all six keys;
   - **proves that environment's database user holds `readWrite` on its own database and nothing else**;
   - warns when mongo's or Caddy's definition in `compose.yml` has changed, without recreating either;
   - pulls the image by digest, and runs that environment's **migrations in a one-off container** while
     its API keeps serving;
   - replaces `api-<env>` and only that container. The old one gets 40 s to finish open requests and
     queued email, and Caddy holds requests through the swap (`lb_try_duration 45s`);
   - waits for it to be **healthy**. A crash, a restart or an unhealthy report puts that environment's
     previous image back and fails the job;
   - records the digest and keeps each environment's current and previous images.

   A failure before the switch leaves the VM as it was. **A deploy never restarts MongoDB or the
   other environment's API.**
5. **`smoke`** — from outside, against that environment's host:
   - ready is 200;
   - HSTS is set;
   - `/api/v1/auth/me` without a token is 401;
   - CORS answers the app's origin and no other;
   - `/api/docs` is 200 on staging and 404 in production.

### GitHub configuration

No deployment secret is stored in GitHub; every value is an identifier. `deploy/gcp/provision.sh` prints
them. Set them on both GitHub environments, `staging` and `production`:

| Variable | The same in both | Example |
|---|---|---|
| `GCP_PROJECT_ID` | yes | `project-2bac9fc9-f453-47b4-a29` |
| `GCP_WIF_PROVIDER` | yes | `projects/<number>/locations/global/workloadIdentityPools/github/providers/github-oidc` |
| `GCE_INSTANCE` | yes | `agencyboost-backend` |
| `GCE_ZONE` | yes | `asia-southeast2-b` |
| `GCP_BUILD_SA` | per environment | `gh-builder-staging@…` / `gh-builder-prod@…` |
| `GCP_DEPLOY_SA` | per environment | `gh-deployer-staging@…` / `gh-deployer-prod@…` |
| `API_HOST` | per environment | `staging-api.agencyboost.id` / `api.agencyboost.id` |
| `APP_ORIGIN` | per environment | `https://staging.agencyboost.id` / `https://agencyboost.id` |

The registry is not a variable: it follows from `GCP_PROJECT_ID` and the environment.

**The one secret is CI's, not a deployment's**: `SUPERPROJECT_DEPLOY_KEY`, a read-only deploy key of the
superproject, so the tests can read its `docs/` and `prototype/` (CI/CD, below). It is a repository secret,
not an environment's, and a Dependabot secret as well.

**The environments are the approval gate** (D5). `production` allows deployments from `main` only, and
`staging` from `development` only. The Workload Identity provider accepts a token only from this
repository (pinned by numeric id), and for each environment only from its branch and its workflow files:
`deploy.yml`, plus `seed-staging.yml` on staging.

### Adopting the VM, step by step

The VM exists already (`agencyboost-backend`, made in the console). These steps make it the
deployment target, in this order. The runbook has the checks after each one.

1. **Provision the project around it**, from a laptop signed in to `gcloud` as a project Owner. Read
   the dry run first:

   ```bash
   deploy/gcp/provision.sh --project project-2bac9fc9-f453-47b4-a29 \
     --alert-email <ops address> --dry-run
   ```

   It looks up the two numeric ids WIF is pinned to (the repository's owner and the repository) itself:
   through `gh` when it is signed in (`gh auth login`), else GitHub's public API, which answers only for a
   public repository. If neither can, it stops and says how to read them in a browser (the repository
   page's source, `octolytics-dimension-user_id` and `octolytics-dimension-repository_id`); then pass them
   with `--github-owner-id <n> --github-repo-id <n>`.

   Then run it without `--dry-run`. It creates or adopts:
   - the five service accounts (`api-runtime`, `gh-builder-staging`, `gh-builder-prod`,
     `gh-deployer-staging`, `gh-deployer-prod`) and their roles;
   - the three buckets, with CORS and lifecycle, and the two immutable registries;
   - the three secrets, empty;
   - the WIF pool and provider;
   - the firewall rules: web for this VM, and SSH from IAP only;
   - the static address, promoted from the VM's ephemeral `34.101.182.17`;
   - the snapshot schedule on disk `mongodb`;
   - OS Login, and deletion protection;
   - with `--alert-email`, the backup-failure alert.

   It never stops the VM.
2. **Change the VM's identity.** It runs as the default compute account with limited scopes, so it cannot
   read Secret Manager, sign upload URLs or write a backup. `provision.sh` prints three commands: stop,
   `set-service-account` to `api-runtime` with scope `cloud-platform`, and start. Run them, or re-run
   `provision.sh` with `--apply-vm-identity`. This is a minute or so of downtime, and the address stays
   because it is static by now.
3. **DNS**: A records for `api.agencyboost.id` and `staging-api.agencyboost.id`, both to the static
   address.
4. **Fill the three secrets**:
   - `api-env-staging` and `api-env-prod` from
     [`deploy/env/api.env.example`](deploy/env/api.env.example), one per environment;
   - `mongo-root` from [`deploy/env/mongo.env.example`](deploy/env/mongo.env.example).

   Use `gcloud secrets versions add <secret> --data-file=…`.
5. **Bootstrap the VM, once**:

   ```bash
   gcloud compute scp --recurse --tunnel-through-iap --zone=asia-southeast2-b deploy agencyboost-backend:agencyboost-bootstrap
   gcloud compute ssh agencyboost-backend --tunnel-through-iap --zone=asia-southeast2-b \
     --command='sudo bash agencyboost-bootstrap/vm/bootstrap.sh && rm -rf agencyboost-bootstrap'
   ```

   On Ubuntu 26.04 (and 24.04, and Debian 12) it does the following:
   - installs Docker. It uses Docker's apt repository when it publishes the release, else Ubuntu's
     `docker.io` and `docker-compose-v2`, and refuses a compose older than 2.30;
   - installs the Cloud CLI;
   - installs the Ops Agent where Google supports the release. Otherwise it warns: logs then stay on the
     VM, and the backup alert stays blind;
   - turns on security updates, and adds 2 GB of swap;
   - sets up the data disk `mongodb`. It is formatted XFS **only if it is blank**, reused as it is if
     it already holds a filesystem, and refused if it holds a partition table;
   - installs `/opt/agencyboost`, the systemd units and the two deployers' sudoers rules.
6. **Set the GitHub variables** (above), and restrict each environment's deployment branches.
7. **Let CI read the superproject.** Without this every deploy stops at `ci`. On a laptop signed in to
   `gh` as an owner of both repositories:

   ```bash
   ssh-keygen -t ed25519 -N '' -C 'agency-boost-backend CI: read the superproject' -f ./superproject-ci
   gh repo deploy-key add ./superproject-ci.pub --repo <owner>/agency-boost --title 'agency-boost-backend CI (read-only)'
   gh secret set SUPERPROJECT_DEPLOY_KEY --repo agency-boost/agency-boost-backend < ./superproject-ci
   gh secret set SUPERPROJECT_DEPLOY_KEY --repo agency-boost/agency-boost-backend --app dependabot < ./superproject-ci
   rm ./superproject-ci ./superproject-ci.pub
   ```

   A deploy key reads one repository and is read-only unless `--allow-write` is given. Where the
   superproject is not `agency-boost/agency-boost`, name it once:
   `gh variable set SUPERPROJECT_REPOSITORY --repo agency-boost/agency-boost-backend --body <owner>/agency-boost`.
8. **Deploy staging**: run `deploy` from `development`, then `seed staging`.
9. **Deploy production**: run `deploy` from `main`, then create the first Super Admin (below).
10. **Close port 22 to the world.** The default network's `default-allow-ssh` opens it for every VM in
   the project. `provision.sh` prints the command to delete it, and does not run it, because the rule
   is not this VM's alone.

### On the VM

`/opt/agencyboost` mirrors `deploy/`: `compose.yml`, `Caddyfile`, `bin/` and `mongo/init/`. It also has
two directories of its own:
- `env/`: the rendered secrets, mode 0700;
- `state/staging/` and `state/prod/`: each environment's current and previous digests.

Use `sudo /opt/agencyboost/bin/compose.sh ps` or `… logs api-prod` rather than calling compose
directly. Every deploy and seed is in the journal: `sudo journalctl -u 'agencyboost-deploy-*'`, and
`-u 'agencyboost-seed-*'`.

**At boot, `agencyboost.service` runs `compose up --no-recreate`.** It starts the environments that have
been deployed, creates what is missing and starts what is stopped. It never recreates a container whose
definition has changed: a reboot does not restart MongoDB onto a new definition. When `compose.yml`
changes mongo's or Caddy's definition, every deploy prints a loud warning (and a GitHub Actions
annotation) until a person recreates that service at a quiet time:
`sudo /opt/agencyboost/bin/compose.sh up --detach --no-deps --force-recreate mongo` (or `caddy`).
Recreating mongo stops both environments for a few seconds.

### Rolling back

- **Re-run the `deploy` job of an earlier green run** of that environment (Actions → that run → Re-run
  jobs). It deploys that run's digest again; a re-run skips the "still the branch head" check. Nothing
  is migrated backwards: every migration leaves the database readable by the version before it
  (`ci-cd.md`, Migrations).
- Or, on the VM, as an operator:
  `sudo /opt/agencyboost/bin/deploy.sh prod "$(sudo cat /opt/agencyboost/state/prod/previous)"` (with
  `staging` in both places for staging).
- A deploy whose image never turns healthy has already rolled itself back; the job is red.
- Data: the scheduled snapshots, production's pre-deploy snapshot, and the nightly dumps (below).

### Seeding staging

Actions → **seed staging** → run from `development`, typing `reset staging`. It builds the `tools` image
into `agencyboost-staging` and runs `sudo /opt/agencyboost/bin/seed.sh staging …` on the VM, in a systemd
unit of its own.
- **It connects as staging's database user**, after proving that user's only role is `readWrite` on
  `agencyboost_staging`, so its `--reset` cannot touch production's database.
- The workflow has a concurrency group of its own, and the VM's lock keeps it apart from deploys and
  backups.

Production cannot be seeded at all: the workflow has no production path, `seed.sh` takes `staging` and
nothing else, and the sudoers rules allow it to staging's deployer alone.

### The first Super Admin

Production has nobody who can sign in until one is made, once, by hand:

```bash
gcloud compute ssh agencyboost-backend --tunnel-through-iap --zone=asia-southeast2-b
sudo /opt/agencyboost/bin/create-super-admin.sh prod owner@example.com --name "Full Name"
```

The password is asked for twice and never echoed. It runs in `api-prod`, so the account lands in
production's database. It refuses when a Super Admin already exists; after the first, make others from
the console.

### Mail

**The provider is chosen by the environment alone**
([ADR-0182](../docs/04-adr/0182-the-mail-provider-is-chosen-by-env-staging-sends-through-gmail.md)):
`MAIL_PROVIDER` is `gmail`, `sendgrid`, `mailjet`, `clicksend`, `ses`, `smtp` (any relay `SMTP_HOST` names) or
`log`, and a preset fills the host, the port and TLS (`src/modules/notifications/mail-provider.ts`). Staging sends
through the product's Gmail account; production is SES until go-live chooses. Every email is multipart, its HTML
derived from the text, with `MAIL_REPLY_TO` when set. To switch, add a new version of `api-env-<env>` and redeploy the
same image (runbook §13); then send one message with that environment's settings and look in the inbox and the spam
folder:

```bash
sudo /opt/agencyboost/bin/send-test-mail.sh staging you@example.com    # node dist/cli/send-test-mail.js in api-staging
```

It prints the provider, the host, the port and the server's answer, never the password, and exits 0 when the
server accepted the message. Each provider's recipe, and staying out of spam:
[`../docs/03-engineering/email-delivery.md`](../docs/03-engineering/email-delivery.md).

### Backups

- **Snapshots of the data disk `mongodb`**:
  - every 4 hours, kept 14 days, covering both databases, since there is one disk;
  - every production deploy takes one first. Those are labelled `predeploy=true` and **do not expire**:
    the deployer may create them but not delete them, so prune them by hand (the runbook):
    `gcloud compute snapshots list --project=project-2bac9fc9-f453-47b4-a29 --filter="labels.predeploy=true AND creationTimestamp<-P30D" --format="value(name)"`.
- **`mongodump`, nightly** at 01:30 Jakarta time (`agencyboost-backup.timer`), one archive per
  deployed environment's database:
  - `gs://agencyboost-backups/prod/…`, kept 30 days;
  - `gs://agencyboost-backups/staging/…`, kept 7 days.

  The VM's role on that bucket creates and reads objects, and can neither delete nor overwrite one.
  `sudo systemctl start agencyboost-backup` takes one now.
- **A failed backup reports itself**: its `OnFailure=` unit logs `AGENCYBOOST_BACKUP_FAILED`, which the
  alert from `provision.sh --alert-email` mails out. Without the Ops Agent or the alert, look for it with
  `journalctl -t agencyboost-backup -p err`.
- Both kinds live in this one project, so **neither survives the project being deleted**. A backups
  bucket in a separate project, or a locked retention policy, is a P19-T6 option.
- Restore drills, Mongo upgrades and secret rotation are in the runbook.

The Vercel function files (`vercel.json`, `api/index.js`, `src/serverless.ts`) are the old staging path
(ADR-0041). They are removed at the T7 cutover, once staging on the VM has passed.

## CI/CD

**`ci.yml`** runs on every pull request, and as the first job of every deploy (`workflow_call`), on
Node 24:

| Job | What fails it |
|---|---|
| `quality` | Unscoped `pnpm.overrides`; `pnpm lint`; `pnpm typecheck`; `pnpm test:unit`; `openapi.json` not what `pnpm openapi` produces |
| `integration` | `test:integration` and `test:tenancy`, each under `TZ=UTC`, `Asia/Jakarta` and `America/New_York` |
| `coverage` | The coverage ratchet: global 80%, domain 95%, tenancy and permissions 100% branch |
| `performance` | `pnpm test:performance`: a read over its budget at p95, one suite at a time. No other run includes these suites (`jest.config.ts` says why) |
| `audit` | `pnpm audit --audit-level high`. It ignores one advisory, which has no patched release: `../docs/02-specs/nfr/security-and-privacy.md`, *Dependencies* |
| `container` | The runtime or tools image does not build. The runtime image runs as root, cannot load argon2, or its readiness does not answer 200 beside a database, 503 once the database stops, and 200 when it returns (`deploy/ci/container-smoke.sh`). Either image carries a `gha-creds*` credentials file or an `.env`: the job plants decoys of both in the build context first (`deploy/ci/no-secrets-in-image.sh`) |
| `scripts` | `bash -n` or shellcheck on any `deploy/**/*.sh` or `.github/ci/*.sh`. Or `deploy/compose.yml` that does not resolve, publishes an API, binds Mongo beyond loopback, would create the data directory, gives an environment's API (or the staging seed) the other environment's env file, or leaves a service without a memory limit or an API without a heap cap (`deploy/ci/compose-config.sh`) |

The `deploy/ci/` scripts run the same on a laptop with Docker, from this directory.

**`quality`, `integration` and `coverage` read the superproject.** The parity specs pin the metric
registry, the permission matrix and the prototype's lists against the code, and read them at `../docs`
and `../prototype`, where the superproject puts them on a laptop. On CI this repository is checked out
alone, so `.github/ci/superproject-beside.sh` clones those two folders beside it first, with
`SUPERPROJECT_DEPLOY_KEY` (*Adopting the VM*, step 7). It reads a pull request's own branch where the
superproject has one, otherwise the branch it merges into, and for a push the branch pushed: **when a
change moves a pinned number and its doc, push the superproject's docs commit first**, or re-run CI.

**Jest reads no `.env`.** Under `NODE_ENV=test`, `app.module.ts` skips the file, and a suite that
imports the real `AppModule` imports `test/boot-env.ts` above it, so a suite runs on a laptop exactly as
it does on CI.

**Every action in every workflow is pinned by commit**, with its version in a comment beside it. A tag
can be moved, and whoever moves it would run with this repository's deploy identity.
**`.github/dependabot.yml`** proposes new pins weekly, as ordinary PRs. Every workflow's token is
read-only (`permissions: contents: read`); the deploy jobs add only `id-token: write`, for Workload
Identity Federation.

**`companion-pr.yml`** fails a PR touching `src/` that names neither its superproject PR nor `docs:none`.

**`deploy.yml`** is above. **`seed-staging.yml`** is manual, staging only.

How the three repositories' workflows fit together is in
[`../docs/03-engineering/ci-cd.md`](../docs/03-engineering/ci-cd.md).

## Status

Every phase through 18.6 has shipped (16 was retired and 10.2 canceled): every role's screens and
endpoints, through the Owner's compliance tree.
**Phase 18.7, Environments and deployment** ([phase file](../docs/05-delivery/phases/phase-18.7-environments-and-deployment.md)),
adds the container, the VM, the pipeline and Cloud Storage. Phase 19 hardens it for real customers'
data; until then production stays dark.
