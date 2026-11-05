# Control plane API (M5)

The contract between the `pmx` CLI (the free client in `src/cloud/`, Apache-2.0, and the paid client in `ee/`, source-visible) and the hosted control plane (closed source). Both sides are built against this document. Change it here first.

**Rule (SCOPE-8):** the control plane stores only IDs, sizes, statuses, counts and timings. No task titles, descriptions, transcripts, drafts or source text are ever written to its storage or logs. The canvas proxy (CANVAS-3) passes task content through to the browser and stores none of it.

## Basics

| Item | Value |
|---|---|
| Base URL | `https://api.productgit.com/v1` (CLI config `controlPlane.url`) |
| Format | JSON, UTF-8. Errors are `{ "error": "<code>", "message": "<text>" }` with a 4xx/5xx status. |
| Auth (browser) | Cognito user pool JWT (`Authorization: Bearer <id token>`), from the hosted UI at `auth.productgit.com`. |
| Auth (CLI) | A **machine token** (`pmxm_` + 40 base62 chars), sent as `Authorization: Bearer pmxm_…`. Stored in the macOS keychain (SEC-10). The server stores only its SHA-256. |
| Roles | `admin` or `member`, per org. |
| Clock | All times are ISO-8601 UTC strings. |

## Plans (PLAN-1 to PLAN-4)

Every signed-in user gets a **free** org. The UI is free; team analytics and the brain are paid.

| Capability | `free` | `team` / `enterprise` |
|---|---|---|
| Hosted board (canvas proxy), invites, members, Linear broker | yes | yes |
| `POST /events` (content-free events, kept 400 days) | yes | yes |
| `GET /policy` and `PUT /policy` without `brain` | yes | yes |
| `GET /analytics` and the analytics page | `402 upgrade_required` | yes |
| `policy.brain.level` other than `"off"` | `402 upgrade_required` | yes |
| Cloud leases, license JWT | `402 upgrade_required` | yes |

A `402` body is `{ "error": "upgrade_required", "message": "<what needs a paid plan>", "feature": "analytics" | "brain" | "lease" | "license" }`. Events from a free org are stored the same way, so its analytics are complete on the day it upgrades.

## CLI sign-in

1. `pmx login` starts a listener on `127.0.0.1:<random port>` and opens `https://app.productgit.com/cli-login?port=<port>&state=<nonce>`.
2. The web app signs the user in through Cognito, calls `POST /v1/machine-tokens` with `{ "label": "<hostname hash>" }`, and redirects the browser to `http://127.0.0.1:<port>/callback?state=<nonce>&token=<pmxm_…>`.
3. The CLI checks `state`, stores the token in the keychain, and stops listening.
4. If `pmx.config.json` has no `controlPlane`, the CLI calls `GET /me`. With one org it uses that org; with several it asks; with none it calls `POST /orgs { name: <team> }`, which creates a `free` org. The org ID goes in the personal config (`cloud.orgId`), and `pmx login` offers to write `controlPlane` into `pmx.config.json` so teammates join the same org.
5. The CLI shows what analytics events contain and that `pmx analytics off` stops them (PRIV-5). Sending starts only after this step.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/machine-tokens` | Cognito only | `{ label }` | `201 { token, tokenId }` |
| DELETE | `/machine-tokens/{tokenId}` | any | — | `204` |

## Orgs, members and invites

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/orgs` | Cognito | `{ name }` | `201 { orgId }`. The caller becomes `admin`. |
| GET | `/me` | any | — | `200 { userId, email, orgs: [{ orgId, name, role, plan }] }` |
| POST | `/orgs/{orgId}/invites` | admin | `{ email, role }` | `201 { code, expiresAt, inviteFile }` (see below) |
| POST | `/invites/{code}/accept` | Cognito | — | `200 { orgId, role }` |
| GET | `/orgs/{orgId}/members` | admin | — | `200 { members: [{ userId, email, role, joinedAt }] }` |

`inviteFile` is the team invite file for CLI-1 (`npx productgit init --invite pmx-invite.json`):

```json
{
  "version": 1,
  "controlPlaneUrl": "https://api.productgit.com/v1",
  "orgId": "org_…",
  "inviteCode": "inv_…",
  "team": { "repo": "git@github.com:acme/pmx.git", "linearTeamKey": "PROD", "linearProjectId": "…" }
}
```

The `team` block is copied from the org's admin policy (`teamDefaults`).

## Admin policy (ADMIN-2)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/orgs/{orgId}/policy` | any member | — | `200 Policy` |
| PUT | `/orgs/{orgId}/policy` | admin | `Policy` without `version`/`updatedAt` | `200 Policy` (version + 1) |

```ts
type Policy = {
  version: number;                 // increases on every PUT
  updatedAt: string;
  allowedCategories: string[];     // e.g. ["research-synthesis","competitive-analysis","tracking-hygiene","spec"]
  allowedSources: ("transcripts" | "slack")[];
  allowedPlans: ("team" | "enterprise" | "api" | "bedrock" | "vertex")[];
  egressAllowlist: string[];       // domains a run may reach, e.g. ["api.linear.app","github.com","api.anthropic.com"]
  model?: string;                  // fixes the team model (NEUT-1) when set
  reviewQueueCap?: number;         // overrides PULL-4 default
  teamDefaults?: { repo?: string; linearTeamKey?: string; linearProjectId?: string };
  brain?: BrainPolicy;             // paid (BRAIN-1); absent means "off"
};

type BrainPolicy = {
  level: "off" | "recommend" | "approve" | "autopilot";
  machine: string | null;          // agent handle of the one machine that runs the brain; null = the team's synthesizer
  everyHours: number;              // 1–24, default 4
  autopilot: {                     // limits for level "autopilot"; anything outside them waits for a person
    actions: ("make-ready"|"set-priority"|"set-size"|"start-run"|"release"|"pause-category")[];
    maxSize: "S" | "M" | "L" | "XL";
    categories: string[];          // empty = every allowed category
    maxRunsPerDay: number;         // start-run actions per day, across the team
  };
};
```

Brain levels (BRAIN-2): `recommend` posts each suggestion as a tracker comment and changes nothing; `approve` queues each action until a person approves it (`pmx brain --review`); `autopilot` carries out actions inside the limits and queues the rest. At every level the brain never approves an output: a person reviews every result (REV-1).

The CLI caches the last policy at `~/.pmx/policy.json` and applies it as an **intersection** with team config: a category, source, plan or domain is allowed only if both allow it. If the cache is older than 7 days and the server is unreachable, ee commands stop (fail closed).

## Leases (PULL-6, M5 form)

A DynamoDB conditional-write lease with a fencing token. Replaces the git-ref lease when team config sets `"lease": "cloud"`.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/orgs/{orgId}/leases/{taskId}` | member | `{ holder, ttlSeconds }` | `201 Lease`, or `409 { error: "held", holder, expiresAt }` |
| POST | `/orgs/{orgId}/leases/{taskId}/renew` | member | `{ holder, fencingToken, ttlSeconds }` | `200 Lease`, or `409` |
| DELETE | `/orgs/{orgId}/leases/{taskId}` | member | `{ holder, fencingToken }` | `204`, or `409` |
| GET | `/orgs/{orgId}/leases` | member | — | `200 { leases: Lease[] }` (active only) |

```ts
type Lease = { taskId: string; holder: string; fencingToken: number; acquiredAt: string; expiresAt: string };
```

Semantics:
- Acquire succeeds when no holder exists, the current lease has expired, or `holder` already holds it (idempotent retry).
- `fencingToken` increases by 1 on every successful acquire of that task and never decreases. Release keeps the counter.
- `holder` is the agent handle (`<pm handle>@<machine id>`). It is an ID, not a name.
- Every tracker write the CLI makes for a leased task carries the fencing token in the run record; a write with an older token than the latest is a bug.

## License (ADMIN-4)

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/orgs/{orgId}/license` | member | `200 { jwt }` |
| GET | `/.well-known/jwks.json` | none | `200 { keys: [JWK] }` |

The JWT is signed by an AWS KMS asymmetric key (`ECC_NIST_P256`, `ECDSA_SHA_256`), so it is **ES256**.

```json
// header
{ "alg": "ES256", "typ": "JWT", "kid": "<KMS key id>" }
// claims
{
  "iss": "https://api.productgit.com",
  "sub": "org_…",
  "aud": "pmx-cli",
  "plan": "team",            // "team" | "enterprise" | "pilot"
  "seats": 5,
  "features": ["lease", "review-caps", "policy", "ledger-sync", "analytics", "brain"],
  "iat": 1767225600,
  "exp": 1769817600          // 30 days; the CLI refreshes when < 7 days remain
}
```

The CLI ships the production public key and verifies offline. `status` other than `active` on the org (past due, canceled) means no new license is issued; the current one runs to `exp`.

## Billing (ADMIN-4)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/orgs/{orgId}/checkout` | admin | `{ plan: "team", seats }` | `200 { url }` (Stripe Checkout session) |
| POST | `/orgs/{orgId}/billing-portal` | admin | — | `200 { url }` |
| POST | `/stripe/webhook` | Stripe signature | raw Stripe event | `200` |

Webhook events handled: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. They set the org's `plan`, `seats` and `status` (`active` / `past_due` / `canceled`). The Stripe customer ID maps to the org; nothing else from Stripe is stored.

## Linear OAuth broker (ADMIN-3)

No PM needs a personal Linear API key.

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/orgs/{orgId}/linear/authorize` | admin | `302` to Linear's OAuth consent (`scope=read,write,issues:create,comments:create`, `actor=app`) |
| GET | `/linear/callback` | state cookie | Stores tokens, `302` to `app.productgit.com/admin?linear=connected` |
| POST | `/orgs/{orgId}/linear/token` | member | `200 { accessToken, expiresAt }` |
| DELETE | `/orgs/{orgId}/linear` | admin | `204` (revokes and deletes) |

Tokens are encrypted with a KMS symmetric key before they are stored. The access token handed to the CLI is short-lived; the broker refreshes it with the stored refresh token. The CLI keeps it in memory only. Tracker writes stay scoped to the PMX project in the CLI adapter (SEC-4).

## Content-free events and analytics (P7, CANVAS-4)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/orgs/{orgId}/events` | member | `{ events: Event[] }` (max 100) | `202 { accepted }` |
| GET | `/orgs/{orgId}/analytics?days=30` | member, paid plan | — | `200 Analytics`, or `402` on `free` |

```ts
type Event =
  | { type: "run"; id: string; at: string; taskId: string; category: string; size: "S"|"M"|"L"|"XL";
      skillVersion: string; runtime: string; outcome: "ok"|"failed"|"capped"; durationMs: number;
      tokens?: number; costUsd?: number; agent: string }
  | { type: "verdict"; id: string; at: string; taskId: string; category: string; size: "S"|"M"|"L"|"XL";
      verdict: "accepted"|"rejected"|"redo"; editSize?: number; reviewMinutes?: number; agent: string }
  | { type: "pipeline"; id: string; at: string; kind: "digest"|"synthesize"; outcome: "staged"|"no-signal"|"failed"|"posted"|"dry-run";
      found: number; used: number; cut: number; tasks?: number; costUsd?: number; agent: string }
  | { type: "brain"; id: string; at: string; taskId: string | null;
      action: "make-ready"|"set-priority"|"set-size"|"start-run"|"release"|"pause-category"|"hold";
      mode: "recommended"|"queued"|"executed"|"approved"|"declined"|"blocked"; rule?: string; agent: string };

type Analytics = {
  days: number;
  acceptRateByCategory: Record<string, { accepted: number; rejected: number; redo: number; rate: number }>;
  cycleTimeHoursP50: number | null;    // run end → verdict
  runsBySize: Record<"S"|"M"|"L"|"XL", number>;
  spendUsd: number;
  byAgent: Record<string, { runs: number; accepted: number }>;
  pipeline: { digests: number; suggestRuns: number; suggestedTasks: number; sourcesFound: number; sourcesUsed: number };
  brain: { byAction: Record<string, Record<"recommended"|"queued"|"executed"|"approved"|"declined"|"blocked", number>>;
           humanApprovalRate: number | null };   // approved / (approved + declined)
};
```

The server rejects any event with fields not listed above (so content can't leak in by accident). `id` makes posting idempotent. `rule` on a `brain` event is one of the fixed guard rule IDs in `ee/src/brain/guard.ts` (for example `size-over-limit`), never free text.

The free CLI sends `run`, `verdict` and `pipeline` events once its user has signed in and not turned analytics off (PRIV-5). The paid brain adds `brain` events.

## Canvas proxy (CANVAS-1, CANVAS-3)

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/orgs/{orgId}/canvas/board` | member | `200 Board` |

The proxy reads the org's PMX project from Linear with the brokered token on each request, maps labels to zones, and returns the result. It writes nothing to storage or logs except the request count and latency.

```ts
type Card = { id: string; identifier: string; title: string; url: string; category: string | null;
              size: "S"|"M"|"L"|"XL" | null; status: string; agent: string | null; priority: number;
              prUrl: string | null; preview: string | null; sources: number };
type Board = { zones: { pool: Card[]; ready: Card[]; inFlight: Card[]; review: Card[]; done: Card[] };
               fetchedAt: string };
```

## Linear label mapping (TASK-6)

Shared by the CLI adapter and the canvas proxy. Each is a Linear **label group**, so an issue carries at most one label from each.

| Group | Labels |
|---|---|
| `pmx-status` | `inbox`, `ready`, `claimed`, `running`, `review`, `done`, `blocked` |
| `pmx-category` | one per category, e.g. `research-synthesis` |
| `pmx-size` | `S`, `M`, `L`, `XL` |
| `pmx-agent` | the agent handle that claimed it (created on demand) |
| `pmx-kind` | `meeting`: a lodged team meeting in the meeting ledger (MEET-2), not a task. Its description has one `pmx:meeting <hash>` line per meeting identity and one `pmx:task <ID>` line per task it produced; when processed it gets `pmx-status: done` and the team's completed workflow state. The canvas proxy, pull and the brain skip it. |

The PR link is the last `pmx:pr <url>` line in the issue's comments. Sources are `pmx:source <id>` lines in the description.
