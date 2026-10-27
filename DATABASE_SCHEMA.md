# DATABASE_SCHEMA.md

Server schema (PostgreSQL in production, SQLite in development and tests) and the
device schema (IndexedDB).

---

## 1. One schema, two dialects

`apps/api/src/db/migrations/001_init.sql` is the single definition. The migration runner
renders it per dialect by substituting type tokens, so PostgreSQL and SQLite can never
drift into two hand-maintained schemas.

| Token | PostgreSQL | SQLite | Used for |
|---|---|---|---|
| `{{PK}}` | `UUID` | `TEXT` | Primary and foreign keys |
| `{{TEXT}}` | `TEXT` | `TEXT` | Names, codes, free text |
| `{{INT}}` | `INTEGER` | `INTEGER` | Counts, whole measurements |
| `{{REAL}}` | `DOUBLE PRECISION` | `REAL` | Temperature, weight, glucose |
| `{{BOOL}}` | `BOOLEAN` | `INTEGER` | Flags |
| `{{TS}}` | `TEXT` | `TEXT` | ISO-8601 timestamps |
| `{{JSON}}` | `JSONB` | `TEXT` | Rule lists, audit metadata, rule sets |

### Why timestamps are TEXT

ISO-8601 strings sort lexicographically, so `BETWEEN` range filters and
`substr(ts, 1, 10)` day-grouping behave identically in both engines with no dialect
branching, and a timestamp written on a device in one timezone round-trips to the server
without a conversion that could silently shift a visit date. The cost is that date
arithmetic happens in application code rather than SQL, which for this workload is a
handful of millisecond differences.

---

## 2. Entity relationship diagram

```
                         ┌──────────────┐
                         │    users     │
                         │──────────────│
                         │ PK id        │
                         │    username U│
                         │    password_hash
                         │    role      │
                         │    chw_identifier
                         │    village   │
                         │    status    │
                         └──┬────────┬──┘
                created_by  │        │  chw_id
              ┌─────────────┘        └──────────────┐
              │                                      │
      ┌───────v────────┐                     ┌──────v───────┐
      │    patients    │                     │    visits    │
      │────────────────│  1            0..*  │──────────────│
      │ PK id          │─────────────────────│ PK id        │
      │    local_id    │        patient_id   │ FK patient_id│
      │    first_name  │                     │ FK chw_id    │
      │    last_name   │                     │    visit_date│
      │    age, sex    │                     │    village   │
      │    village     │                     │    notes     │
      │    phone       │                     │    version   │
      │    consent_status                    └──┬───┬───┬───┘
      │ FK created_by  │                        │   │   │
      │    version     │             visit_id   │   │   │
      └───────┬────────┘        ┌───────────────┘   │   └──────────────┐
              │                 │                   │                  │
              │         ┌───────v────────┐  ┌───────v───────┐  ┌───────v────────┐
              │         │  vital_signs   │  │   symptoms    │  │ triage_results │
              │         │────────────────│  │───────────────│  │────────────────│
              │         │ PK id          │  │ PK id         │  │ PK id          │
              │         │ FK visit_id  U │  │ FK visit_id   │  │ FK visit_id  U │
              │         │    systolic_bp │  │    symptom_code  │    risk_level  │
              │         │    diastolic_bp│  │    severity   │  │    triggered_rules
              │         │    temperature_c  │    duration_days │    recommendation
              │         │    pulse_bpm   │  │  U(visit,code)│  │    referral_required
              │         │    oxygen_saturation                 │    ruleset_version
              │         │    blood_glucose_mmol                └────────────────┘
              │         └────────────────┘
              │
              │  1                      0..*
              └───────────────────────────────┐
                                      ┌────────v────────┐
                                      │    referrals    │
                                      │─────────────────│
                                      │ PK id           │
                                      │ FK patient_id   │
                                      │ FK visit_id     │
                                      │    destination  │
                                      │    urgency      │
                                      │    status       │
                                      │    follow_up_date
                                      │ FK created_by   │
                                      │    version      │
                                      └─────────────────┘

  Independent tables:

  ┌──────────────────┐  ┌───────────────────┐  ┌──────────────────┐  ┌─────────────┐
  │ awareness_content│  │ triage_rulesets   │  │  sync_receipts   │  │ audit_logs  │
  │──────────────────│  │───────────────────│  │──────────────────│  │─────────────│
  │ PK id            │  │ PK id             │  │ PK idempotency_key  │ PK id       │
  │    title         │  │    version      U │  │ FK user_id       │  │ FK user_id  │
  │    language      │  │    definition     │  │    entity_type   │  │    action   │
  │    category      │  │    active         │  │    entity_id     │  │    entity_type
  │    body          │  │    approved_by    │  │    operation     │  │    entity_id│
  │    audio_path    │  │    approved_on    │  │    result_status │  │    timestamp│
  │    version       │  │ FK created_by     │  │    received_at   │  │    metadata │
  │    active        │  │    created_at     │  └──────────────────┘  │    ip_address
  └──────────────────┘  └───────────────────┘                        └─────────────┘

  U = UNIQUE
```

---

## 3. Tables

### `users`

| Column | Type | Constraints |
|---|---|---|
| `id` | PK | PRIMARY KEY (client or server generated UUID) |
| `name` | TEXT | NOT NULL |
| `phone` | TEXT | |
| `username` | TEXT | NOT NULL **UNIQUE** |
| `password_hash` | TEXT | NOT NULL — scrypt, format `scrypt$<cost>$<salt>$<key>` |
| `role` | TEXT | NOT NULL, CHECK IN (`CHW`,`NURSE`,`OFFICIAL`,`ADMIN`) |
| `chw_identifier` | TEXT | Field badge number; null for non-field roles |
| `village` | TEXT | |
| `status` | TEXT | NOT NULL DEFAULT `ACTIVE`, CHECK IN (`ACTIVE`,`SUSPENDED`) |
| `created_at`, `updated_at` | TS | NOT NULL |

Indexes: `idx_users_role`, `idx_users_village`.

### `patients`

| Column | Type | Constraints |
|---|---|---|
| `id` | PK | PRIMARY KEY — **client-generated UUID** |
| `local_id` | TEXT | NOT NULL — short human code, e.g. `P-4F2A` |
| `first_name`, `last_name` | TEXT | NOT NULL |
| `age` | INT | NOT NULL, CHECK 0–130 |
| `sex` | TEXT | NOT NULL, CHECK IN (`FEMALE`,`MALE`,`OTHER`) |
| `village` | TEXT | NOT NULL |
| `phone` | TEXT | |
| `consent_status` | TEXT | NOT NULL, CHECK IN (`GRANTED`,`DECLINED`,`WITHDRAWN`) |
| `created_by` | PK | NOT NULL REFERENCES `users(id)` |
| `created_at`, `updated_at` | TS | NOT NULL |
| `version` | INT | NOT NULL DEFAULT 1 — monotonic, drives conflict detection |

Indexes: `idx_patients_village`, `idx_patients_created_by` (the CHW-scoped list query),
`idx_patients_name` (`last_name, first_name`), `idx_patients_local_id`.

### `visits`

| Column | Type | Constraints |
|---|---|---|
| `id` | PK | PRIMARY KEY |
| `patient_id` | PK | NOT NULL REFERENCES `patients(id)` **ON DELETE CASCADE** |
| `chw_id` | PK | NOT NULL REFERENCES `users(id)` |
| `visit_date` | TS | NOT NULL |
| `village` | TEXT | NOT NULL — denormalised so village analytics need no join to patients |
| `notes` | TEXT | |
| `version` | INT | NOT NULL DEFAULT 1 |

Indexes: `idx_visits_patient` (`patient_id, visit_date`), `idx_visits_chw`,
`idx_visits_date`, `idx_visits_village` (`village, visit_date`).

### `vital_signs`

One row per visit. `visit_id` is **UNIQUE**, so a duplicated sync upload fails at the
database rather than quietly double-recording a blood pressure.

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `visit_id` | PK | NOT NULL **UNIQUE** REFERENCES `visits(id)` ON DELETE CASCADE |
| `systolic_bp`, `diastolic_bp` | INT | Nullable — **null means not measured**, never "normal" |
| `temperature_c`, `weight_kg`, `blood_glucose_mmol` | REAL | Nullable |
| `pulse_bpm`, `oxygen_saturation`, `respiratory_rate` | INT | Nullable |
| `recorded_at` | TS | NOT NULL |

Bounds are enforced by Zod at the API boundary rather than by CHECK constraints, so a
rejected reading produces a field-level message the CHW can act on instead of a driver
error. The bounds are in `packages/shared/src/schemas.ts` (`VITAL_BOUNDS`).

### `symptoms`

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `visit_id` | PK | NOT NULL REFERENCES `visits(id)` ON DELETE CASCADE |
| `symptom_code` | TEXT | NOT NULL — the identifier triage rules reference |
| `symptom_name` | TEXT | NOT NULL — label as shown at capture time |
| `severity` | TEXT | NOT NULL, CHECK IN (`MILD`,`MODERATE`,`SEVERE`) |
| `duration_days` | INT | Nullable |

**UNIQUE (`visit_id`, `symptom_code`)** — the same symptom cannot be recorded twice for
one visit, which makes a replayed sync an upsert rather than a duplicate.

### `triage_results`

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `visit_id` | PK | NOT NULL **UNIQUE** REFERENCES `visits(id)` ON DELETE CASCADE |
| `risk_level` | TEXT | NOT NULL, CHECK IN (`RED`,`AMBER`,`GREEN`) |
| `triggered_rules` | JSON | Rule IDs that fired |
| `triggered_labels` | JSON | Plain-language labels shown to the CHW |
| `recommendation` | TEXT | NOT NULL |
| `referral_required` | BOOL | NOT NULL |
| `ruleset_version` | TEXT | NOT NULL — **which rules produced this verdict** |
| `evaluation_ms` | REAL | NOT NULL — measured against the 1 s target |

`ruleset_version` is the auditability column: months later it is still possible to say
which thresholds were in force when a patient was screened.

Indexes: `idx_triage_risk` (`risk_level, created_at`), `idx_triage_created`.

### `referrals`

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `patient_id`, `visit_id` | PK | NOT NULL, FK, ON DELETE CASCADE |
| `destination` | TEXT | NOT NULL |
| `urgency` | TEXT | NOT NULL, CHECK IN (`IMMEDIATE`,`WITHIN_24H`,`ROUTINE`) |
| `reason` | TEXT | NOT NULL |
| `status` | TEXT | NOT NULL, CHECK IN (`PENDING`,`ACKNOWLEDGED`,`COMPLETED`,`CANCELLED`) |
| `follow_up_date` | TEXT | Date only (YYYY-MM-DD) |
| `created_by` | PK | NOT NULL REFERENCES `users(id)` |
| `completed_at` | TS | |
| `version` | INT | NOT NULL DEFAULT 1 |

Indexes: `idx_referrals_status`, `idx_referrals_patient`, `idx_referrals_followup`,
`idx_referrals_urgency` (`urgency, status` — the dashboard's default ordering).

### `awareness_content`

`id`, `title`, `language` (BCP-47), `category`, `summary`, `body`, `audio_path`,
`version`, `active`, `updated_at`. Indexes: `idx_awareness_lang` (`language, category`),
`idx_awareness_live` (`active`).

### `triage_rulesets`

Stores the rule set so thresholds are **configuration, not code** (spec §8).

`id`, `version` (UNIQUE), `definition` (JSON), `active`, `approved_by`, `approved_on`,
`created_by`, `created_at`. Index: `idx_rulesets_active`.

Publishing a new version deactivates the previous one in the same transaction. A stored
rule set that fails structural validation at load is **not used**; the server falls back
to the version bundled with the build and logs the errors, because mis-triaging a
patient from a corrupt configuration is worse than running the known-good default.

### `sync_receipts`

The table that makes synchronisation idempotent.

| Column | Type | Notes |
|---|---|---|
| `idempotency_key` | TEXT | **PRIMARY KEY** — `<entityType>:<entityId>:<operation>:<version>` |
| `user_id` | PK | NOT NULL REFERENCES `users(id)` |
| `entity_type`, `entity_id`, `operation` | | What was received |
| `result_status` | TEXT | `APPLIED` / `DUPLICATE` / `CONFLICT` / `REJECTED` |
| `received_at` | TS | NOT NULL — drives the "last sync" figures |

Indexes: `idx_receipts_entity`, `idx_receipts_user` (`user_id, received_at`).

### `audit_logs`

`id`, `user_id` (nullable — a failed sign-in has no user), `action`, `entity_type`,
`entity_id`, `timestamp`, `metadata` (JSON), `ip_address`.

Indexes: `idx_audit_user` (`user_id, timestamp`), `idx_audit_action`,
`idx_audit_entity`, `idx_audit_time`.

`metadata` passes through `scrubMetadata()`, which **drops** any key matching a list of
clinical and identifying field names. An audit log containing the health data it is
protecting would be a second copy of the sensitive record with weaker controls around
it, so the exclusion is enforced in code rather than left to each caller.

---

## 4. Migrations

```bash
npm run migrate
```

- Files live in `apps/api/src/db/migrations/`, applied in filename order.
- Each is applied **exactly once** and recorded in `schema_migrations`.
- Each runs **inside one transaction**: a half-applied schema change is worse than none.
- The runner is idempotent, so it is safe on every boot — and the API does run it at
  boot so a fresh deployment is usable without a manual step.

**The production schema is never edited by hand.** Every change is a new numbered file:

```
003_add_gps_coordinates.sql
004_add_patient_merge_table.sql
```

The statement splitter is a single-pass tokenizer, because the two hazards interact: a
`--` comment may contain a semicolon, and a string literal may contain `--`. Splitting
on comments and semicolons in separate passes gets one of the two wrong whichever order
is chosen. (This was a real bug during development: a comment reading
`-- One vitals record per visit; the unique constraint…` split a `CREATE TABLE` in half.)

---

## 5. The device schema (IndexedDB)

Managed by Dexie in `apps/chw/src/db/local.ts`.

| Store | Keys and indexes |
|---|---|
| `patients` | `id`, village, updatedAt, syncStatus, localId |
| `visits` | `id`, patientId, visitDate, syncStatus |
| `vitals` | `id`, visitId |
| `symptoms` | `id`, visitId, symptomCode |
| `triage` | `id`, visitId, riskLevel, createdAt |
| `referrals` | `id`, patientId, visitId, status, followUpDate, syncStatus |
| `queue` | `id`, status, nextAttemptAt, entityType, entityId |
| `awareness` | `id`, language, category, active |
| `meta` | `key` — PIN salt, verifier, sealed session, cached rule set |

It mirrors the server schema with two deliberate differences:

1. **Identifying fields are encrypted** into a `sec` blob (`{ iv, ct }`). Non-identifying
   fields stay in the clear so they remain indexable. See `OFFLINE_ARCHITECTURE.md` §3.
2. **`syncStatus` exists on the device only.** It is device bookkeeping — `PENDING`,
   `SYNCING`, `SYNCED`, `FAILED` — and is stripped before a record is sent.

Device migrations use Dexie's `version(n).stores({...})` mechanism; adding a version
migrates existing installations in place without data loss.

---

## 6. Capacity

The specification targets 500 patient profiles and 30 days of visits per device, and
≥10,000 patients with ≥100 concurrent CHWs on the server.

- **Device:** 500 patients with roughly 3 visits each is on the order of 5–10 MB in
  IndexedDB, well inside a typical multi-hundred-megabyte quota. Measured in
  `tests/offline.test.ts` (*capacity*).
- **Server:** every query the dashboard issues is covered by an index listed above. The
  heaviest is the village aggregation, which scans `visits` over a date range using
  `idx_visits_village` and joins on the primary keys of `triage_results` and
  `referrals`.
- **Symptom trends:** the district trend query reads `symptoms` joined to `visits` and
  `triage_results` across two equal windows, using `idx_symptoms_visit` and
  `idx_visits_village`. It runs twice per request — once for the current period and once
  for the comparison period — which is why the window is bounded to a year.
- **Growth:** `audit_logs` and `sync_receipts` grow without bound. A production
  deployment should archive both on a retention schedule; see `ADMIN_GUIDE.md` §8.

This is an engineering target supported by the indexing strategy, **not a measured
benchmark** — no load test has been run.
