# Offline-First Mobile Health Monitoring System

**Early disease detection and improved disease awareness in rural communities.**

A screening system for Community Health Workers (CHWs) who work where the network does
not reach. The governing principle, and the thing every design decision here answers to:

> Everything a CHW needs to capture, assess and manage a patient works without internet.
> Connectivity determines **when** the health facility receives the data — never whether
> the CHW can work.

---

## Contents

| Document | What it covers |
|---|---|
| [`PROJECT_ANALYSIS.md`](PROJECT_ANALYSIS.md) | Starting state, stack decisions, architecture, implementation plan |
| [`OFFLINE_ARCHITECTURE.md`](OFFLINE_ARCHITECTURE.md) | Exactly how the system keeps working with no network |
| [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md) | ERD, tables, keys, indexes, constraints, migrations |
| [`API_DOCUMENTATION.md`](API_DOCUMENTATION.md) | Every endpoint, with request and response shapes |
| [`SECURITY.md`](SECURITY.md) | Threat model, authentication, encryption, audit, known limits |
| [`USER_GUIDE_CHW.md`](USER_GUIDE_CHW.md) | Guide for community health workers |
| [`ADMIN_GUIDE.md`](ADMIN_GUIDE.md) | Guide for administrators and health officials |
| [`TRACEABILITY_MATRIX.md`](TRACEABILITY_MATRIX.md) | Requirement → objective → feature → test → result |

---

## 1. What is in this repository

Four applications and two shared libraries, in one npm workspace:

```
Health system/
├── apps/
│   ├── api/          Node + Express REST API          (@rhm/api)
│   ├── chw/          Offline-first CHW client, a PWA  (@rhm/chw)
│   └── dashboard/    Health-official web dashboard    (@rhm/dashboard)
├── packages/
│   ├── shared/       Domain types, validation, RBAC, SMS rules   (@rhm/shared)
│   └── triage/       The offline triage rule engine + rule file  (@rhm/triage)
└── tests/            Integration, offline and failure tests
```

### The CHW client is a PWA, not a native Android app

The specification expressed a preference for Kotlin and Jetpack Compose. The build host
for this project has **no JDK and no Android SDK**, which means a Kotlin module could
have been written but never compiled, run or tested — and the specification's first
instruction is to build a working application rather than an explanation of one.

The client is therefore an installable Progressive Web App: React, TypeScript, Vite,
IndexedDB and a service worker. Every functional requirement is met (see the mapping
table in `PROJECT_ANALYSIS.md` §2.2), it installs to the Android home screen from
Chrome on Android 7.0+, and it can be wrapped into an APK with a Trusted Web Activity
(Bubblewrap) when a Play Store listing is wanted. The honest trade-offs are listed in
[§11 Limitations](#11-known-limitations-of-this-mvp).

---

## 2. Architecture

```
                    ┌─────────────────────────────────────┐
                    │        CHW PWA (Android 7+)         │
                    │                                     │
                    │  React UI — large targets, offline  │
                    │      │                              │
                    │  Repository layer                   │
                    │      │                              │
                    │  Dexie / IndexedDB  <-- SOURCE OF   │
                    │   (AES-256-GCM at rest)     TRUTH   │
                    │      │                              │
                    │  SyncQueue — outbox pattern         │
                    │      │                              │
                    │  Sync engine (backoff, idempotent)  │
                    └──────┼──────────────────────────────┘
                           │  HTTPS / TLS 1.2+
                           v
                    ┌─────────────────────────────────────┐
                    │      Express API   /api/v1          │
                    │  auth · RBAC · validation · rate    │
                    │  limit · idempotency · audit        │
                    └──────┼──────────────────────────────┘
                           │
                    ┌──────v──────────┐      ┌────────────────┐
                    │  PostgreSQL     │<-----│  Web dashboard │
                    │  (SQLite dev)   │      │ React+Recharts │
                    └─────────────────┘      └────────────────┘
```

`@rhm/triage` runs in **both** the browser and the server, from one rule file. The
browser copy is the one that matters clinically: it is what produces the CHW's result,
offline, in under a millisecond.

---

## 3. Requirements

| | |
|---|---|
| Node.js | **22.5 or newer** (24 recommended) — the API uses the built-in `node:sqlite` and native TypeScript type stripping |
| npm | 10 or newer |
| PostgreSQL | 13+ (production only; development and tests use SQLite) |
| Browser | Chrome 60+ / any modern browser for the three web clients |

No JDK, no Android SDK, and no native compilation toolchain are required.

---

## 4. Setup

```bash
npm install
cp .env.example .env
```

Then create the database and load the demonstration data:

```bash
npm run seed
```

That runs the migrations and writes a fictional demonstration dataset: 7 users, 120
patients, 311 screenings, 120 referrals and 8 awareness topics.

### Environment variables

Every variable is documented in [`.env.example`](.env.example). The ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | API port |
| `DB_DIALECT` | `sqlite` in dev, `postgres` in production | |
| `SQLITE_PATH` | `./data/rhm.db` | Relative paths resolve from the repository root |
| `DATABASE_URL` | — | **Required** when `DB_DIALECT=postgres` |
| `JWT_SECRET` | ephemeral in dev | **Required in production**, minimum 32 characters. The process refuses to start without it |
| `ACCESS_TOKEN_TTL` | `604800` (7 days) | Long on purpose: a CHW offline for a week must not be locked out |
| `CORS_ORIGINS` | localhost dev ports | Comma-separated |

Generate a production secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

---

## 5. Running it

Four terminals, or four tabs:

```bash
npm run dev:api
```

```bash
npm run dev:chw
```

```bash
npm run dev:dashboard
```

| Service | URL |
|---|---|
| API | http://localhost:4000 (`/api/v1`) |
| CHW application | http://localhost:5173 |
| Dashboard | http://localhost:5174 |

All three front ends proxy `/api` to the API in development, so there is no CORS setup to do.

### Demonstration accounts

All demo accounts use the password **`DemoPass2026`**. They exist only in seeded data.

| Username | Role | What they see |
|---|---|---|
| `chw1` … `chw4` | CHW | The CHW application; only their own patients |
| `nurse` | Nurse / health officer | Dashboard, referrals, patient detail |
| `officer` | District official | Dashboard aggregates only — never a patient identity |
| `admin` | Administrator | Users, roles, triage rules, awareness content, audit log |

---

### Running it from VS Code

The repository ships a `.vscode/` folder, so this is mostly clicking.

**First time**

1. Open the folder: `code "C:\Users\davew\Desktop\Health system"`, or File → Open Folder.
2. VS Code will offer the recommended extensions — accept. They are optional but useful:
   REST Client (drive the API from `requests.http`), SQLite Viewer (open `data/rhm.db`),
   and the Vitest explorer.
3. If prompted *"Use the workspace TypeScript version?"*, say **yes**. The build needs
   TypeScript 5.9 features that an older bundled compiler reports as errors.
4. **Ctrl+Shift+P** → `Tasks: Run Task` → **Setup: install dependencies**.
5. Same again → **Setup: create database + demo data**.

**Every time**

**Ctrl+Shift+B** — this runs **▶ Start everything** and opens four terminal tabs: the API
and all three clients. Ctrl+click the URLs it prints.

Or press **F5** and pick **▶ Run everything (API + all three clients)**: identical, except
the API starts under the debugger so you can set breakpoints in it.

**Other tasks** (Ctrl+Shift+P → `Tasks: Run Task`)

| Task | |
|---|---|
| ▶ Start everything | All three servers, one terminal tab each |
| API / CHW app / Dashboard | Just one of them |
| Test | The full suite once |
| Test: watch | Re-runs on save |
| Typecheck (all workspaces) | Errors appear in the Problems panel |
| Reset demo data | Deletes every `DEMO-` record and reseeds |

**Debugging** (F5, or the Run and Debug panel)

| Configuration | |
|---|---|
| Debug API | Breakpoints in any `.ts` file under `apps/api` |
| Debug tests (all) | Step through the whole suite |
| Debug tests (current file) | Just the file you are looking at |
| Debug seeder | Step through demo-data generation |
| Open CHW app / Dashboard | Launches Chrome against a running dev server |

Breakpoints work directly in the TypeScript with no build step and no source maps: Node
strips types by replacing them with whitespace, so line numbers match the file exactly.

**Hitting the API without leaving the editor**

Open `requests.http`, click **Send Request** above the `loginChw` block, then above any
other block — the token is captured and reused. It covers the clinical endpoints, the
sync idempotency demonstration (send the same block twice and watch the second return
`DUPLICATE`), and the two privacy boundaries that must return 403.

**Looking at the database**

With the SQLite Viewer extension installed, click `data/rhm.db` in the Explorer.

---

## 6. Trying the offline behaviour

The fastest way to see the point of the whole system:

1. Open http://localhost:5173, sign in as `chw1` / `DemoPass2026`, and set a PIN.
2. **Stop the API** (Ctrl-C in its terminal). This is a harder test than airplane mode:
   the network is up and the server is simply gone.
3. In the app: register a patient, start a screening, enter **165 / 100**, tap
   **Headache** and set it to 3 days, and check the result.
4. The result is **RED — URGENT REFERRAL**, computed on the device in under a
   millisecond. Save the screening; it is stored immediately.
5. The strip at the top of every screen reads `OFFLINE — n RECORDS SAVED ON THIS PHONE`.
6. Reload the page. Everything is still there. Unlock with the PIN — no network involved.
7. **Restart the API.** Within a moment the strip reads `ONLINE — EVERYTHING SENT`.
8. Check the dashboard: the patient and the screening have arrived, exactly once.

The demonstration script in `ADMIN_GUIDE.md` §7 walks through this for an examiner.

---

## 7. Testing

```bash
npm test
```

167 tests across six suites:

| Suite | Tests | Covers |
|---|---|---|
| `packages/triage/src/engine.test.ts` | 36 | Rule engine, missing facts, combination policy, determinism, performance |
| `tests/api.auth.test.ts` | 24 | Password hashing, JWT, login, rate limiting, RBAC on live routes |
| `tests/api.sync.test.ts` | 22 | Idempotency, partial success, conflicts, failure handling, throughput |
| `tests/api.clinical.test.ts` | 34 | Patients, visits, triage, referrals, SMS minimisation, analytics, privacy |
| `tests/offline.test.ts` | 22 | Offline workflow, zero data loss, encryption at rest, capacity |

The offline suite is the one that matters most. It runs the **real** client stack — the
real Dexie schema, real AES-GCM encryption, real repository transactions and the real
sync engine — against the **real** Express API over a real HTTP socket. Only the network
failure is simulated, and it is simulated the way it actually happens: `fetch` rejects.

Type checking:

```bash
npm run typecheck
```

---


---

## 8. Design system

All three clients share one token set — palette, radii, shadows, type scale — so they
read as one product. The visual language follows current healthcare-app conventions
(strong type hierarchy, tinted surface cards, icon chips, stat strips, pill selectors,
layered shadows, floating navigation), adapted for a field tool rather than a consumer
marketplace.

### The palette, and a clinical reason for it

The brand is **deep teal** (`#0f766e`), not the green it started as. That change was
made for a reason beyond taste:

- **Green is a risk level in this product.** A green primary button competes with
  "GREEN — no danger signs". Teal frees green to carry exactly one meaning.
- **Red/green is the common colour-vision deficiency pair.** Keeping the interface
  chrome out of that pair leaves the risk colours doing that work alone.
- It also makes RED *louder*: `#7f1d1d` against teal separates far more sharply than it
  did against forest green.

Three details do most of the work in making this read as a designed product rather than
a default theme:

| Detail | |
|---|---|
| **The curved content sheet** | The page body is a rounded sheet lifting over the gradient hero, not a panel butting against a coloured bar. Pure CSS, no image |
| **Tinted shadows** | Shadows carry the brand hue (`rgba(10, 74, 82, …)`), never black. A black shadow over a coloured canvas reads as dirt; a hue-matched one reads as light |
| **A tinted canvas** | The page behind the cards is `#f2f8fa`, never pure white. It is what makes white cards read as floating rather than as holes |

### What was adopted

| Pattern | Where, and why it earns its place |
|---|---|
| Greeting → large headline | CHW home. A flat grid of equal-weight cards makes the user read everything to find the one thing they came to do |
| Tinted surface cards | Stat tiles and dashboard KPIs. Eight identical white boxes all look the same at a glance; an official scanning for the one that changed needs them to differ |
| Icon chips | Everywhere. Gives a low-literacy reader a shape to recognise before they read the label |
| Stat strips | Patient record. Summarises the clinical picture before the visit list, rather than making the CHW read it |
| Pill selectors | Dates, times, filters, symptom severity |
| Layered shadows, larger radii | Ambient plus contact shadow reads as depth; a single drop shadow reads as a grey halo |
| Floating pill navigation | CHW app. Lifted off the edge, so it reads as a control rather than a border |

### What was deliberately rejected

This matters more than the list above, because the references are selling appointments
and this application tells a health worker that someone may be dying.

1. **Dark, saturated photographic heroes.** They look excellent on a studio monitor and
   are unreadable on a cheap LCD in direct sunlight, which is where this is used. The
   header uses a subtle CSS gradient instead — and the hero card's decorative ring is
   pure CSS, so there is nothing to download on a 2G connection.
2. **Glassmorphism and backdrop blur.** Contrast collapses outdoors, and the compositing
   cost is real on a 2 GB phone.
3. **Softened pastel risk colours.** The triage result is unchanged through every
   restyle: full-bleed `#7f1d1d`, one 46px word, white on dark. A consumer app's colour
   is decoration; ours is the difference between a patient reaching a facility today and
   not. Colour is also never the only signal — every risk level carries its word.
4. **Denser rows and smaller controls.** Touch targets stay at 56px. The user is standing
   in a compound holding a BP cuff in the other hand.
5. **Model photography and avatars of practitioners.** This is a clinical record, not a
   marketplace. Patient initials appear on a tinted tile; no faces, no stock imagery.

### Icons and type

Two things were keeping the interface looking like a default theme long after the layout
was right, and both were fixed late:

**Icons are real SVG, not typographic characters.** The interface previously used `~`,
`!`, `◷` and `♪` inside rounded squares. A punctuation mark in a tile does not read as an
icon — it reads as a placeholder. There is now a hand-drawn stroke set (24×24, 1.8 stroke,
`currentColor`) in `components/icons.tsx`, inline in the bundle: nothing extra to
download, every icon inherits its container's colour, and there is no flash of missing
glyphs while an icon font loads. The set is duplicated per client rather than shared,
because `@rhm/shared` has no React dependency and adding one would pull a UI framework
into the API's dependency graph.

**The typeface is Plus Jakarta Sans**, self-hosted, variable weight. The system stack
renders as Segoe UI on Windows and is the single most recognisable "default" signal in a
product. Only two subsets ship — `latin` and `latin-ext` — because `latin-ext` carries
**ŋ**, which Luganda orthography needs. The other five subsets the package
offers are omitted deliberately: a browser downloads only the subset a page needs, but the
CHW service worker precaches *every* asset in the build, so an unused subset is weight
carried onto every device over 2G. `font-display: swap` means text paints immediately in
the fallback and upgrades when the font arrives.

### Cost

| | CSS (gzipped) | Fonts |
|---|---|---|
| CHW app | 21 KB (5.2 KB) | 49 KB, precached once |
| Dashboard | 13 KB (3.9 KB) | 49 KB |

No icon library, no images, no illustrations. The CHW precache is 479 KB in total —
roughly 1% of the 50 MB package budget in spec §21.

---

## 9. Deployment

### API

```bash
NODE_ENV=production \
DB_DIALECT=postgres \
DATABASE_URL=postgresql://... \
JWT_SECRET=<48 random bytes, hex> \
npm run start -w @rhm/api
```

Migrations run automatically at boot and are idempotent. Terminate TLS at a reverse
proxy (nginx, Caddy, a managed load balancer) — the API expects to sit behind one and
sets `trust proxy` in production so client IPs in the audit log and the rate limiter are
correct.

### Web clients

```bash
npm run build -w @rhm/chw        # -> apps/chw/dist
npm run build -w @rhm/dashboard  # -> apps/dashboard/dist
```

Both are static bundles; serve them from any static host or the same reverse proxy. Set
`VITE_API_BASE` at build time if the API is on a different origin.

**The CHW application must be served over HTTPS.** Service workers, the Web Crypto API
and installability all require a secure context. `http://localhost` is exempt for
development only.

CHW client build size: **408 KB** (127 KB gzipped), 414 KB precached — comfortably
inside the 50 MB budget in the specification.

### Optional: wrapping the CHW client as an APK

```bash
npx @bubblewrap/cli init --manifest https://your-host/manifest.webmanifest
npx @bubblewrap/cli build
```

This produces a Trusted Web Activity APK for Play Store distribution. It needs a JDK
and the Android SDK, which is why it is not part of the default build.

---

## 10. Known limitations of this MVP

Stated plainly, because a project that hides its limits cannot be evaluated.

1. **The triage rules are not clinically approved.** `clinical-rules.json` ships as a
   configuration **template** whose `approvedBy` field is `null`, and the application
   says so on every result screen. The thresholds are placeholders drawn from widely
   published general-reference danger signs so the engine can be exercised end to end.
   A health authority must review and approve them before any real use.
2. **SMS is composed, not sent.** Web code cannot send an SMS. The app composes the
   minimal-disclosure message and hands it to the device's SMS app, where the CHW taps
   Send. The message content and the safety check are identical either way.
3. **Encryption at rest protects a locked device, not a compromised one.** Patient
   identifiers are AES-256-GCM encrypted inside IndexedDB under a PIN-derived key. This
   defends a lost or stolen phone. It does not defend against malware inside the browser
   profile, or against someone who has the PIN. See `SECURITY.md` §6.
4. **Rate limiting is per-process.** Behind a load balancer with several API instances
   the effective limit multiplies by the instance count. A multi-instance deployment
   should move the counters to Redis.
5. **No geographic map.** The specification mentions a map of village activity. The
   dashboard presents village activity as ranked tables and charts instead; adding a map
   needs village coordinates, which no part of the current data model collects.
6. **Sync is upload-only.** Devices push what they captured; they do not pull other
   CHWs' records. This matches the field workflow and keeps the privacy boundary simple,
   but it means a patient seen by two CHWs has two records until they are merged at the
   facility.
7. **Biometric unlock is a convenience, not a second key.** WebAuthn does not return key
   material, so a fingerprint can stand in for re-typing the PIN within an unlocked
   session but cannot replace it as the source of the encryption key.
8. **Scale is designed for, not load-tested.** The schema, indexes and sync protocol
   target ≥100 concurrent CHWs and ≥10,000 patients. That figure is an engineering
   target supported by the indexing strategy, not a measured benchmark; no load test has
   been run.

---

## 11. A note on what this system is

It is a **decision-support tool for trained community health workers**. It does not
diagnose. It applies rules that a health authority has configured and approved, shows
the CHW what fired and what to do, and makes sure the record reaches the facility. Every
triage result in the application carries that statement, and the rule set records who
approved it and when.
