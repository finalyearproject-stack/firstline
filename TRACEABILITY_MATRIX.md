# TRACEABILITY_MATRIX.md

Requirement → Objective → Feature → Test case → Result.

This project is academic work and the implementation has to be defensible, so every
functional and non-functional requirement below is mapped to the code that implements
it and the test that proves it.

**Verification run:** 2026-09-29 · `npm test` · **138 passed, 0 failed** across 5 suites.

---

## Objectives

| ID | Objective |
|---|---|
| **OBJ-1** | Enable CHWs to capture patient data and perform screening entirely offline |
| **OBJ-2** | Provide immediate, deterministic, configurable offline triage |
| **OBJ-3** | Guarantee that no captured record is ever lost, and that synchronisation creates no duplicates |
| **OBJ-4** | Improve disease awareness through offline, multi-language health content |
| **OBJ-5** | Give health officials timely, privacy-preserving visibility of programme activity |
| **OBJ-6** | Protect health information in transit, at rest, and by role |

## Test case index

| ID | Suite |
|---|---|
| **T1** | `packages/triage/src/engine.test.ts` — 36 tests |
| **T2** | `tests/api.auth.test.ts` — 24 tests |
| **T3** | `tests/api.sync.test.ts` — 22 tests |
| **T4** | `tests/api.clinical.test.ts` — 34 tests |
| **T5** | `tests/offline.test.ts` — 22 tests |
| **TM** | Manual verification in the running application (recorded in §4) |

---

## 1. Functional requirements

| ID | Requirement | Obj | Feature / implementation | Test | Result |
|---|---|---|---|---|---|
| **FR-01** | CHW authentication | OBJ-6 | `routes/auth.ts`, scrypt + HS256 JWT | T2 *issues a token for valid credentials* | ✅ PASS |
| **FR-02** | Application opens and signs in with no network | OBJ-1 | PIN unlock over a PBKDF2-derived key; session sealed on device (`state/session.tsx`) | T5 *registers a patient offline* (runs entirely offline); TM-1 | ✅ PASS |
| **FR-03** | Patient registration | OBJ-1 | `screens/Patients.tsx` → `repository.createPatient` | T4 *creates and reads a patient back*; T5 *registers a patient offline* | ✅ PASS |
| **FR-04** | Patient search | OBJ-1 | `repository.searchPatients` (in-memory over decrypted rows); `GET /patients?search=` | T5 *finds patients offline*; T4 *searches by name, code and village* | ✅ PASS |
| **FR-05** | Patient records and history | OBJ-1 | `getPatientHistory`; `GET /patients/:id/visits` | T5 *shows the patient's history offline*; T4 *returns the full patient history* | ✅ PASS |
| **FR-06** | Visit management | OBJ-1 | `saveScreening`; `POST /visits` | T4 *records a whole encounter in one request* | ✅ PASS |
| **FR-07** | Vital-sign capture | OBJ-1 | Screening step 1; `vitalsSchema` bounds | T4 *rejects an out-of-range age*; T5 *saves a complete screening* | ✅ PASS |
| **FR-08** | Symptom capture | OBJ-1 | Symptom tap-cards, severity and duration (`SYMPTOM_CATALOGUE`) | T1 *resolves symptom presence, severity and duration*; T5 *saves a complete screening* | ✅ PASS |
| **FR-09** | Offline triage, RED/AMBER/GREEN | OBJ-2 | `@rhm/triage` — pure, synchronous, no I/O | T1 (25 tests); T5 *runs triage offline and produces RED* | ✅ PASS |
| **FR-10** | Triage result is immediate and clear | OBJ-2 | `TriageResultView` — level, action, indicators, disclaimer | T1 *evaluates far inside the one-second budget*; TM-2 | ✅ PASS |
| **FR-11** | Rules are configurable, not hard-coded | OBJ-2 | `clinical-rules.json` + `triage_rulesets` table | T1 *changes behaviour when only the threshold in the config changes*; T4 *lets an administrator publish a new rule set* | ✅ PASS |
| **FR-12** | Referral creation | OBJ-1 | Screening step 4; `POST /referrals` | T5 *saves a complete screening with a referral offline* | ✅ PASS |
| **FR-13** | Referral status management | OBJ-5 | `PATCH /referrals/:id`; dashboard Referrals page | T4 *lets a nurse move a referral through its states and audits each change* | ✅ PASS |
| **FR-14** | SMS referral with minimal information | OBJ-6 | `composeReferralSms` + `auditSmsBody`; `POST /referrals/:id/sms` | T4 *composes a message with no clinical content whatsoever*; *keeps every forbidden term out* | ✅ PASS |
| **FR-15** | Follow-up tasks | OBJ-1 | `listFollowUps`; Follow-up screen | T5 *tracks follow-up tasks offline* | ✅ PASS |
| **FR-16** | Health awareness content, offline | OBJ-4 | `AWARENESS_SEED` bundled + cached; `awareness` store | T4 *is readable by every role that works with patients*; TM-3 | ✅ PASS |
| **FR-17** | Awareness in a local language | OBJ-4 | English + Luganda, draft translations flagged in the UI | TM-3 | ✅ PASS (flagged unreviewed) |
| **FR-18** | Awareness audio plays offline | OBJ-4 | Workbox cache-first for `/audio/**`; `<audio>` element | TM-4 | ⚠️ PARTIAL — mechanism verified; **no audio files ship with this repository** |
| **FR-19** | Local encrypted storage | OBJ-6 | AES-256-GCM over a PBKDF2 key (`db/crypto.ts`) | T5 *does not store patient names in readable form*; *cannot be read with the wrong PIN*; *detects tampering* | ✅ PASS |
| **FR-20** | Offline queue (outbox) | OBJ-3 | `queue` store written in the same transaction as the record | T5 *keeps the outbox intact across a restart* | ✅ PASS |
| **FR-21** | Automatic synchronisation | OBJ-3 | `SyncEngine.start()` — online event, 60 s sweep, backoff timer | T5 *uploads everything captured offline* | ✅ PASS |
| **FR-22** | Idempotent synchronisation | OBJ-3 | Deterministic keys + `sync_receipts` primary key | T3 *stores exactly one copy across ten retries*; T5 *still receives exactly one copy when the connection drops* | ✅ PASS |
| **FR-23** | Sync status visible to the CHW | OBJ-1 | Connectivity strip, live query over the outbox | T5 (pending counts asserted throughout); TM-5 | ✅ PASS |
| **FR-24** | Backend REST API | OBJ-5 | Express, `/api/v1`, 30+ endpoints | T2, T3, T4 (80 tests) | ✅ PASS |
| **FR-25** | User and role management | OBJ-6 | `GET/POST/PATCH /users`; dashboard Users page | T2 *refuses to disable the last active administrator* | ✅ PASS |
| **FR-26** | Dashboard overview | OBJ-5 | `GET /dashboard/overview`; Overview page | T4 *counts the overview correctly* | ✅ PASS |
| **FR-27** | Village statistics | OBJ-5 | `getVillageStats`; Villages page | T4 *breaks activity down by village* | ✅ PASS |
| **FR-28** | Disease-risk trends | OBJ-5 | `getTriageTrend`, `getRiskByCategory` | T4 *returns a triage trend and a category breakdown* | ✅ PASS |
| **FR-29** | RED/AMBER/GREEN statistics | OBJ-5 | Overview KPIs and stacked area chart | T4 *counts the overview correctly* | ✅ PASS |
| **FR-30** | CHW activity monitoring | OBJ-5 | `getChwActivity`; CHW activity page | T4 *reports CHW activity* | ✅ PASS |
| **FR-31** | Synchronisation monitoring | OBJ-5 | `getSyncHealth`; Synchronisation page | T3 *reports what the server holds for this CHW* | ✅ PASS |
| **FR-32** | Alert system | OBJ-5 | `getAlerts` — five derived alerts | T4 *raises an alert when a village accumulates RED flags* | ✅ PASS |
| **FR-33** | Audit logging | OBJ-6 | `recordAuditSafely`, `scrubMetadata`; `GET /audit` | T2 *records both successful and failed sign-ins*; T3 *writes one audit entry per batch, with counts but no clinical content* | ✅ PASS |
| **FR-34** | Informed consent | OBJ-6 | Consent statement + status at registration | TM-6 | ✅ PASS |
| **FR-35** | Reports for officials | OBJ-5 | Dashboard analytics pages | T4 (dashboard group, 7 tests) | ✅ PASS |
| **FR-36** | Geographic view of village activity | OBJ-5 | Ranked village tables and RED-rate chart | — | ⚠️ **NOT IMPLEMENTED AS A MAP** — no coordinates are collected. See README §10.5 |

---

## 2. Non-functional requirements

| ID | Requirement | Target | Obj | Implementation | Test | Result |
|---|---|---|---|---|---|---|
| **NFR-01** | Offline capability | 100% of capture, triage and awareness works without network | OBJ-1 | Local-first architecture | T5 (7 tests under *the CHW can work with no network at all*) | ✅ PASS |
| **NFR-02** | Local capacity | ≥500 patients, 30 days of visits | OBJ-1 | IndexedDB + indexes | T5 *stores and searches 500 patients within the performance budget* | ✅ PASS |
| **NFR-03** | Triage performance | Result ≤1 second | OBJ-2 | Pure in-memory rule evaluation | T1 *evaluates far inside the one-second budget*; *stays inside the budget across 1000 consecutive evaluations* | ✅ PASS (sub-millisecond) |
| **NFR-03b** | UI/UX: clean, professional, accessible, rural-use friendly (spec s19) | — | OBJ-1 | Shared token system across all three clients; 56px targets; risk never signalled by colour alone; no webfonts or images | TM-15 | ✅ PASS |
| **NFR-04** | Screen loading | ≤2 s on low-end hardware | OBJ-1 | 408 KB bundle / 127 KB gzipped, precached | TM-7 | ✅ PASS (measured on the dev host, not on target hardware) |
| **NFR-05** | Sync throughput | 100 records in ~60 s on a 2G-quality link | OBJ-3 | 50-record batches, 45 s timeout | T3 *processes a 100-record batch well inside the server-side budget* | ✅ PASS (server share <10 s; network share not measured) |
| **NFR-06** | Reliability — crash | Records survive a crash | OBJ-3 | Single-transaction writes | T5 *keeps every record after the application is closed and reopened* | ✅ PASS |
| **NFR-07** | Reliability — force close | Records survive forced termination | OBJ-3 | Queue entries stay on `SYNCING` | T5 *survives a forced termination in the middle of a sync attempt* | ✅ PASS |
| **NFR-08** | Reliability — battery death | Records survive power loss | OBJ-3 | Atomic IndexedDB transactions | T5 *keeps the outbox intact across a restart* (same mechanism) | ✅ PASS |
| **NFR-09** | Reliability — network failure | Nothing lost when sync fails | OBJ-3 | Requeue, never discard | T5 *preserves records when synchronisation fails outright*; *keeps data when the server returns an error* | ✅ PASS |
| **NFR-10** | Reliability — partial sync | Good records apply, bad ones do not block them | OBJ-3 | Per-item transactions and verdicts | T3 *applies the good records in a batch that also contains a bad one* | ✅ PASS |
| **NFR-11** | Reliability — duplicate requests | Exactly one copy | OBJ-3 | Idempotency keys | T3 *stores exactly one copy across ten retries* | ✅ PASS |
| **NFR-12** | Portability | Android 7.0+, ~2 GB RAM | OBJ-1 | PWA, ES2020 target, Chrome 60+ | TM-8 | ✅ PASS (verified in a Chromium browser; **not on a physical Android 7 device**) |
| **NFR-13** | Package size | APK ≤50 MB where practical | OBJ-1 | 414 KB precached | Build output | ✅ PASS (0.8% of budget) |
| **NFR-14** | Encryption at rest | AES-256 | OBJ-6 | AES-256-GCM, PBKDF2 210k | T5 (4 tests under *encryption at rest*) | ✅ PASS |
| **NFR-15** | Encryption in transit | TLS 1.2+ | OBJ-6 | HTTPS, HSTS in production | Deployment configuration | ✅ PASS (configuration-level; not testable in the suite) |
| **NFR-16** | App lock | PIN / biometric | OBJ-6 | PIN unlock; WebAuthn as a convenience gate | TM-1 | ⚠️ PARTIAL — PIN full; biometrics cannot supply key material (README §9.7) |
| **NFR-17** | Authorisation | Enforced on both tiers | OBJ-6 | `rbac.ts` shared; server middleware on every route | T2 *enforces the matrix on live routes, not only in the UI* | ✅ PASS |
| **NFR-18** | Privacy separation | Officials see aggregates only | OBJ-6 | Aggregate-only queries; permission split | T4 *NEVER returns identifiable patient data to a district official* | ✅ PASS |
| **NFR-19** | Input validation | Structured, both tiers | OBJ-6 | Zod schemas shared by client and server | T4 *rejects an out-of-range age*; T3 *reports a per-item verdict* | ✅ PASS |
| **NFR-20** | API rate limiting | Present | OBJ-6 | Fixed-window limiter, two buckets | T2 *rate-limits repeated failed attempts*; T4 *exposes rate-limit headers* | ✅ PASS (per-process; see README §9.4) |
| **NFR-21** | Secure error handling | No internal detail leaks | OBJ-6 | Central handler, typed codes | T3 *does not leak internal detail when something unexpected fails* | ✅ PASS |
| **NFR-22** | No secrets in source | — | OBJ-6 | Environment variables; `.env` git-ignored | T2 *never returns a password hash when listing users* | ✅ PASS |
| **NFR-23** | No sensitive data in logs | — | OBJ-6 | `scrubMetadata` blocklist | T3 *writes one audit entry per batch, with counts but no clinical content* | ✅ PASS |
| **NFR-24** | Usability — screening time | ≤5 minutes after minimal training | OBJ-1 | 4-step flow, tap-cards, numeric keypads | TM-9 | ⚠️ **NOT FORMALLY MEASURED** — see §5 |
| **NFR-25** | Usability — SUS score | ≥70 | OBJ-1 | Large targets, plain language, always-visible status | — | ❌ **NOT MEASURED** — requires a study with real CHWs. See §5 |
| **NFR-26** | Scalability | ≥100 concurrent CHWs, ≥10,000 patients | OBJ-5 | Indexed schema, pooled connections, batched sync | — | ⚠️ **DESIGNED FOR, NOT LOAD-TESTED.** See README §9.8 |
| **NFR-27** | API versioning | Present | OBJ-5 | `/api/v1` from the first release | T4 (all routes) | ✅ PASS |
| **NFR-28** | Database migrations | Scripted, never manual | OBJ-5 | Numbered SQL, transactional, idempotent | Applied by every test run via the harness | ✅ PASS |

---

## 3. Clinical-safety requirements

The specification is explicit that clinical protocols must not be invented and presented
as authoritative. These are tracked as requirements in their own right.

| ID | Requirement | Implementation | Test | Result |
|---|---|---|---|---|
| **CS-01** | Rules are a template, not medical authority | `approvedBy: null`, `rulesetVersion` suffixed `-TEMPLATE`, disclaimer in the file | T1 *is explicitly marked as an unapproved template* | ✅ PASS |
| **CS-02** | The disclaimer reaches the user | Shown on every triage result; returned with every `/triage` response | T4 *reproduces the offline engine's verdict on the server* (asserts the disclaimer) | ✅ PASS |
| **CS-03** | A missing measurement never fabricates a finding | Missing facts evaluate false; `absent` is the only operator that matches | T1 *returns false rather than throwing when a fact was never recorded* | ✅ PASS |
| **CS-04** | A RED is never diluted | Highest risk level wins; referral required if any rule requires it | T1 *never lets a concurrent AMBER dilute a RED* | ✅ PASS |
| **CS-05** | Every result records which rules produced it | `ruleset_version`, `triggered_rules` stored on every result | T1 *records the ruleset version that produced the result* | ✅ PASS |
| **CS-06** | A corrupt rule set is never used | Validation at load; falls back to the bundled set | T4 *refuses to publish a malformed rule set* | ✅ PASS |
| **CS-07** | Triage is deterministic | Pure function, no I/O, no model | T1 *produces byte-identical results across repeated runs*; *performs no I/O* | ✅ PASS |
| **CS-08** | Translations are marked until reviewed | `reviewed: false`; a banner in the app | TM-3 | ✅ PASS |

---

## 4. Manual verification

Performed against the running application on 2026-09-29.

| ID | What was verified | Method | Result |
|---|---|---|---|
| **TM-1** | Offline PIN unlock | API stopped; app reloaded; PIN entered; app opened with full data | ✅ PASS |
| **TM-2** | RED result on the specification's worked example | Registered a patient, entered 165/100 + headache 3 days, with the API stopped | ✅ PASS — RED, "URGENT REFERRAL", sub-millisecond |
| **TM-3** | Awareness content offline, language switch, draft flag | Learn tab with the API stopped | ✅ PASS |
| **TM-4** | Awareness audio offline | Player renders and precaching is configured | ⚠️ PARTIAL — no audio files ship with the repository |
| **TM-5** | Connectivity strip accuracy | Saved a patient with the API down; watched the strip through save, reload and reconnect | ✅ PASS (a staleness defect was found here and fixed with a live query) |
| **TM-6** | Consent capture | Registration form read aloud and recorded | ✅ PASS |
| **TM-7** | Screen loading | Navigation between all screens in the browser | ✅ PASS (on the dev host, not target hardware) |
| **TM-8** | Responsive layout | 375 × 812 (phone) and 1440 × 900 (desktop) | ✅ PASS |
| **TM-9** | Screening completion time | Walked the full four-step flow | ⚠️ Informal — completed well inside 5 minutes, but by the developer, not a trained CHW |
| **TM-10** | End-to-end sync | Saved offline, restarted the API, confirmed exactly one copy server-side | ✅ PASS |
| **TM-11** | Symptom trends, district view | Opened Symptom trends as a district official; confirmed rising symptoms listed, village counts below the threshold withheld | ✅ PASS |
| **TM-13** | Quarantine held | Confirmed the report created no patient/visit and left dashboard totals unchanged | ✅ PASS |
| **TM-14** | Staff review queue | Nurse saw the report flagged "Warning sign"; official received 403 | ✅ PASS |
| **TM-15** | Design system | Home screen inspected at 375px; computed styles verified from the CSSOM, including that the RED banner remains full-contrast `#7f1d1d`, the level remains 46px/800, and `--tap` remains 56px | ✅ PASS |

---

## 5. Requirements not met, and why

Stated plainly so the gaps are not hidden between passing rows.

| ID | Requirement | Status | Reason and what would be needed |
|---|---|---|---|
| **NFR-25** | SUS score ≥70 | ❌ Not measured | Requires a usability study with real CHWs: 10+ participants, standard SUS instrument, ethical approval. No amount of engineering substitutes for it |
| **NFR-24** | Screening in ≤5 minutes after minimal training | ⚠️ Not formally measured | The flow was designed for it and completes well inside 5 minutes in developer testing, but "after minimal training" is a claim about trained CHWs and needs the same study |
| **NFR-26** | ≥100 concurrent CHWs, ≥10,000 patients | ⚠️ Designed, not load-tested | Needs a load-testing harness against a PostgreSQL instance. The schema, indexes and batch protocol target it; no measurement supports the number |
| **NFR-12** | Android 7.0+, ~2 GB RAM | ⚠️ Verified by capability, not on device | Chrome 60+ ships on Android 7.0 and supports every API used. Not verified on a physical Android 7 handset |
| **FR-36** | Geographic map | ❌ Not implemented as a map | No coordinates are collected. Would need a `latitude`/`longitude` column on villages or visits, a map library, and offline tiles for the CHW app |
| **FR-18** | Awareness audio | ⚠️ Mechanism only | Caching, playback and offline behaviour are implemented; recording and reviewing the audio in each language is a content task for the deploying authority |
| **NFR-16** | Biometric app lock | ⚠️ Partial | WebAuthn does not return key material, so biometrics gate an already-unlocked session rather than deriving the encryption key. A native app with a hardware keystore would close this |
| — | **Clinical approval of the rules** | ❌ Not obtained | Out of scope for software engineering. The rule set is built to be reviewed and approved, and refuses to pretend it has been |

---

## 6. Coverage summary

| Category | Total | Passed | Partial | Not met |
|---|---|---|---|---|
| Functional (FR) | 36 | 34 | 1 | 1 |
| Non-functional (NFR) | 29 | 23 | 5 | 1 |
| Clinical safety (CS) | 8 | 8 | 0 | 0 |
| **Total** | **73** | **65** | **6** | **2** |

Automated tests: **138 passing, 0 failing.**
