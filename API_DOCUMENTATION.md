# API_DOCUMENTATION.md

REST API for the Offline-First Mobile Health Monitoring System.

**Base path:** `/api/v1` (authenticated)
**Content type:** `application/json` · **Transport:** HTTPS (TLS 1.2+) in production

Versioned from the first release, so a breaking change can ship as `/api/v2` while field
devices that have not been updated in months keep working against `/api/v1`.

---

## 1. Conventions

### Responses

A successful response wraps its payload in `data`:

```json
{ "data": { "id": "…", "firstName": "Sarah" } }
```

A list adds pagination:

```json
{
  "data": [ … ],
  "pagination": { "page": 1, "pageSize": 25, "total": 137, "totalPages": 6 }
}
```

### Errors

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some of the information sent was not valid.",
    "fields": [{ "path": "age", "message": "Number must be less than or equal to 130" }]
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Body or query failed validation; `fields` says where |
| `UNAUTHENTICATED` | 401 | Missing, malformed or invalid token |
| `TOKEN_EXPIRED` | 401 | Valid token, past its expiry — prompt a fresh sign-in |
| `FORBIDDEN` | 403 | Authenticated, but the role lacks the permission |
| `NOT_FOUND` | 404 | No such resource, **or** one the caller may not know exists |
| `CONFLICT` | 409 | Version conflict, duplicate username, duplicate rule set version |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 2 MB, or a sync batch over the item limit |
| `RATE_LIMITED` | 429 | Too many requests; see `Retry-After` |
| `INTERNAL` | 500 | Unexpected server fault. Never carries a stack trace or SQL |

`TOKEN_EXPIRED` is distinct from `UNAUTHENTICATED` on purpose: a client must be able to
tell "sign in again" from "something is wrong", and only the former is worth retrying.

### Authentication

```
Authorization: Bearer <jwt>
```

HS256, seven-day default lifetime. Deliberately long: a CHW offline for a week must not
be locked out of their own device's upload path.

### Rate limiting

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`;
a 429 adds `Retry-After`.

| Bucket | Window | Limit | Key |
|---|---|---|---|
| Sign-in | 15 min | 10 | IP + username |
| Everything else | 1 min | 600 | IP |

The sign-in bucket keys on IP **and** username so that an attacker cannot lock a
specific CHW out of a shared village connection by guessing at their account.

### Security headers

`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'`, and
`Strict-Transport-Security` in production. `X-Powered-By` is disabled.

---

## 2. Roles and permissions

| Permission | CHW | NURSE | OFFICIAL | ADMIN |
|---|:--:|:--:|:--:|:--:|
| `patient:create` | ✅ | | | |
| `patient:read:own` | ✅ | | | |
| `patient:read:all` | | ✅ | | ✅ |
| `patient:update` | ✅ | | | |
| `visit:create` | ✅ | | | |
| `visit:read:own` | ✅ | | | |
| `visit:read:all` | | ✅ | | ✅ |
| `triage:run` | ✅ | | | |
| `referral:create` | ✅ | | | |
| `referral:read` | ✅ | ✅ | | ✅ |
| `referral:update` | | ✅ | | |
| `followup:manage` | | ✅ | | |
| `awareness:read` | ✅ | ✅ | ✅ | ✅ |
| `awareness:manage` | | | | ✅ |
| `sync:push` | ✅ | | | |
| `dashboard:aggregate` | | ✅ | ✅ | ✅ |
| `dashboard:identifiable` | | ✅ | | |
| `report:read` | | ✅ | ✅ | ✅ |
| `user:manage` | | | | ✅ |
| `rules:manage` | | | | ✅ |
| `audit:read` | | | | ✅ |
| `system:configure` | | | | ✅ |

The split between `dashboard:aggregate` and `dashboard:identifiable` is the privacy
boundary: a district official gets counts and trends, never a patient identity. This is
enforced by the queries themselves — the endpoints an official can reach cannot produce
identifiable data — and asserted in `tests/api.clinical.test.ts`.

**Authorisation is enforced on the server for every route.** The clients also hide
controls a role cannot operate, but that is a usability measure and never the control.

---

## 3. Health

### `GET /health`
No authentication. `{ "status": "ok", "time": "…" }`

### `GET /ready`
No authentication. Confirms the database is reachable. 200 `{ "status": "ready" }` or
503 `{ "status": "unavailable" }`.

---

## 4. Authentication

### `POST /api/v1/auth/login`

```json
{ "username": "chw1", "password": "DemoPass2026" }
```

**200**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "expiresAt": "2026-09-25T08:09:50.221Z",
  "user": {
    "id": "dc1a22b2-…",
    "name": "Sarah Nakimuli",
    "username": "chw1",
    "role": "CHW",
    "chwIdentifier": "CHW-001",
    "village": "Kasangati"
  }
}
```

**401** for a wrong password, an unknown username **and** a suspended account, with the
same message in all three cases. The unknown-username path still performs a scrypt
verification against a dummy hash derived at the configured cost, so response timing
does not reveal which usernames exist.

Both outcomes are written to the audit log (`LOGIN_SUCCESS` / `LOGIN_FAILURE`).

### `GET /api/v1/auth/me`
Returns the signed-in user. Used by both clients to restore a session.

### `POST /api/v1/auth/logout`
Tokens are stateless, so this is a client-side discard. It is still audited, because
"when did this user stop working" is a question the trail should answer.

---

## 5. Patients

### `GET /api/v1/patients`
`patient:read:own` or `patient:read:all`

| Query | Default | Notes |
|---|---|---|
| `search` | — | Matches first name, last name or patient code |
| `village` | — | |
| `page` | 1 | |
| `pageSize` | 25 | Max 100 |

**A CHW sees only patients they registered.** The scope is a `created_by = ?` clause in
the SQL, not a filter applied after loading — there is no code path on which another
CHW's records are read and then hidden.

### `POST /api/v1/patients`
`patient:create`

```json
{
  "id": "b4192cb9-38d1-47de-87cd-320df34ac815",
  "localId": "P-RFA2",
  "firstName": "Sarah",
  "lastName": "Nakimuli",
  "age": 52,
  "sex": "FEMALE",
  "village": "Kasangati",
  "phone": "+256772000000",
  "consentStatus": "GRANTED"
}
```

`id` is optional; when the client supplies one it must be a UUID, and supplying it is
what makes an offline-created record keep its identity. `createdBy`, `createdAt` and
`version` are set by the server. **201** with the stored patient.

### `GET /api/v1/patients/:id`
Returns **404**, not 403, when a CHW asks for another CHW's patient: a 403 would confirm
that a patient with that id exists, which is itself information about a person the
caller has no relationship with.

### `PUT /api/v1/patients/:id`
`patient:update`. The server owns the version counter and increments it; a client
claiming a version is ignored, so two dashboard edits cannot both be "version 2".

### `GET /api/v1/patients/:id/visits`
`visit:read:own` or `visit:read:all`. The full clinical history: every visit with its
vitals, symptoms, triage result and referral.

---

## 6. Visits

### `POST /api/v1/visits`
`visit:create`

Records a complete screening encounter **in one transaction**.

```json
{
  "visit":    { "id": "…", "patientId": "…", "visitDate": "…", "village": "Kasangati", "notes": null },
  "vitals":   { "systolicBp": 165, "diastolicBp": 100, "temperatureC": 36.8, "pulseBpm": 88 },
  "symptoms": [ { "symptomCode": "headache", "symptomName": "Headache", "severity": "MODERATE", "durationDays": 3 } ],
  "triage":   { "riskLevel": "RED", "triggeredRules": ["HTN-RED-01"], "triggeredLabels": ["…"],
                "recommendation": "…", "referralRequired": true,
                "rulesetVersion": "1.0.0-TEMPLATE", "evaluationMs": 0.4 },
  "referral": { "destination": "Kasangati Health Centre IV", "urgency": "IMMEDIATE", "reason": "…" }
}
```

`vitals`, `symptoms`, `triage` and `referral` are all optional. The whole encounter
lands together or not at all: a visit stored without its triage result would show a
health official a screening that appears to have found nothing, which is worse than
showing nothing.

**201** with the stored bundle. **400** rolls back everything.

### `GET /api/v1/visits/:id`
One visit with its full bundle.

---

## 7. Triage

### `POST /api/v1/triage`
`triage:run` or `dashboard:aggregate`

```json
{
  "age": 52,
  "systolicBp": 165,
  "diastolicBp": 100,
  "symptoms": [{ "symptomCode": "headache", "severity": "MODERATE", "durationDays": 3 }]
}
```

**200**

```json
{
  "data": {
    "riskLevel": "RED",
    "referralRequired": true,
    "recommendation": "Refer the patient to the health facility immediately…",
    "triggeredRules": ["HTN-RED-01", "HTN-AMBER-01"],
    "triggeredLabels": ["Very high blood pressure together with a persistent headache", "…"],
    "firedRules": [ { "id": "HTN-RED-01", "name": "…", "explanation": "…" } ],
    "rulesetVersion": "1.0.0-TEMPLATE",
    "evaluationMs": 0.12,
    "disclaimer": "THIS FILE IS A CONFIGURATION TEMPLATE, NOT AN APPROVED CLINICAL PROTOCOL…"
  }
}
```

> **The CHW application does not call this endpoint to obtain a result.** It runs the
> identical engine locally and offline. This endpoint exists so the dashboard can
> re-evaluate an encounter against the current rules, and so the two implementations can
> be shown to agree. Nothing clinical depends on it being reachable.

The `disclaimer` travels with every result so no consumer can present the verdict as
clinical authority by accident.

### `GET /api/v1/triage/ruleset`
The active rule set, for devices to cache for offline use.

### `PUT /api/v1/triage/ruleset`
`rules:manage`. Publishes a new rule set and deactivates the previous one in the same
transaction.

- **400** if the rule set fails structural validation — the active set is left untouched
  so devices keep working on a known-good configuration.
- **409** if that `rulesetVersion` already exists. Raise the version to publish a change.

### `GET /api/v1/triage/rulesets`
`rules:manage`. Publication history with approver and date.

---

## 8. Referrals

### `GET /api/v1/referrals`
`referral:read`. Filters: `status`, `urgency`, `village`, `page`, `pageSize`.

Ordered by urgency (`IMMEDIATE` → `WITHIN_24H` → `ROUTINE`), then newest first. Includes
the patient's name, age, sex and village, and the triage risk level — a referral cannot
be acted on without them. A CHW sees only referrals they created; district officials do
not hold `referral:read` at all.

### `POST /api/v1/referrals`
`referral:create`.

### `PATCH /api/v1/referrals/:id`
`referral:update` (nurse). `{ "status": "ACKNOWLEDGED" | "COMPLETED" | "CANCELLED",
"notes": …, "followUpDate": … }`. Moving to `COMPLETED` stamps `completedAt`. Every
change is audited.

### `POST /api/v1/referrals/:id/sms`
`referral:create` or `referral:update`

Returns a **minimal-disclosure** message body. The server composes and audits it; it
does **not** send it. Sending happens on the CHW's handset through the device dialler,
so no patient contact detail is relayed through a third-party gateway.

```json
{
  "data": {
    "phone": "+256772000000",
    "body": "Hello Sarah, Please go to Kasangati Health Centre IV today. Show this code: R-7K2M. From your community health worker."
  }
}
```

Permitted: first name, facility, urgency as a plain instruction, a date where one
applies, and the referral code. **Never**: diagnosis, risk level, vital signs, symptoms,
surname, age or village.

The composed body is checked against a forbidden-term list before it is returned; if a
future template change ever leaked clinical wording the request fails rather than
returning it. **400** when the patient has no phone number on record.

---

## 9. Synchronisation

### `POST /api/v1/sync`
`sync:push`

```json
{
  "clientTime": "2026-09-18T08:05:12.000Z",
  "items": [
    {
      "entityType": "patient",
      "entityId": "b4192cb9-…",
      "operation": "CREATE",
      "idempotencyKey": "patient:b4192cb9-…:CREATE:1",
      "payload": { "id": "b4192cb9-…", "firstName": "Sarah", "…": "…" }
    }
  ]
}
```

`entityType` ∈ `patient` · `visit` · `vitals` · `symptom` · `triage` · `referral`.
Maximum 200 items per batch.

**200 — always, even when some items failed:**

```json
{
  "data": {
    "results": [
      { "entityType": "patient", "entityId": "…", "idempotencyKey": "…",
        "status": "APPLIED", "serverId": "…", "message": null }
    ],
    "summary": { "received": 6, "applied": 6, "duplicates": 0,
                 "conflicts": 0, "rejected": 0, "durationMs": 41 },
    "serverTime": "2026-09-18T08:05:13.000Z"
  }
}
```

| `status` | Meaning | What the client does |
|---|---|---|
| `APPLIED` | Stored | Mark `SYNCED`, remove from the outbox |
| `DUPLICATE` | Already received under this key | Same as `APPLIED` — the server has it |
| `CONFLICT` | The server holds a newer version | Stop offering it; the server's copy stands |
| `REJECTED` | Failed validation, authorisation, or a transient storage fault | Retry with backoff, park as `FAILED` after 8 attempts |

A blanket non-2xx would tell the client "the batch failed" and invite it to retry
records the server has already stored. The per-item verdict is what lets a client clear
exactly the entries that are safely persisted and keep the rest queued.

**Idempotency.** `idempotencyKey` is `<entityType>:<entityId>:<operation>:<version>` and
is a primary key in `sync_receipts`. A retried item — from a dropped connection, a
crashed app, or an impatient CHW — can never create a second record.

**Ordering.** Items are sorted server-side into dependency order, so a client that
enqueued them out of order still lands a referentially consistent result.

### `GET /api/v1/sync/status`
`sync:push`. What the server holds for this user, for reconciliation:
`{ recordsReceived, lastSyncAt, serverTime }`.

---

## 10. Dashboard

All routes require `dashboard:aggregate`. **Every one returns aggregate data only** —
no function behind these endpoints selects a patient name, phone number or clinical
detail.

Shared query parameters: `days` (1–365, default 30), or explicit `from` / `to` ISO
timestamps, plus `village` where applicable.

| Endpoint | Returns |
|---|---|
| `GET /dashboard/overview` | Totals, active CHWs, RED/AMBER/GREEN counts, pending referrals and follow-ups |
| `GET /dashboard/triage` | `{ trend: [{date, RED, AMBER, GREEN}], byCategory: [{category, count}] }` |
| `GET /dashboard/villages` | Per village: patients, visits, RED/AMBER/GREEN, referrals, `redRate` |
| `GET /dashboard/chws` | Per CHW: visits, patients, RED found, referrals, last visit, hours since last sync |
| `GET /dashboard/referrals` | By status, by urgency, created/completed trend, median completion hours |
| `GET /dashboard/screening-volume` | `[{ date, visits }]` |
| `GET /dashboard/alerts` | Derived alerts (below) |
| `GET /dashboard/symptom-trends` | Per symptom: occurrences now and in the preceding equal window, percentage change, movement label, severe share, RED share, village breakdown |
| `GET /dashboard/sync-health` | Receipts, rejections and conflicts in 24 h; devices quiet over 48 h |

### Alerts

| Alert | Trigger | Severity |
|---|---|---|
| RED cluster in a village | ≥ 4 RED results in 30 days | HIGH |
| Referrals pending | ≥ 10 pending | MEDIUM (HIGH at ≥ 25) |
| Devices not synchronising | A CHW quiet for > 48 h | MEDIUM |
| Records rejected | Any rejection in 24 h | MEDIUM |
| Increased activity | ≥ 20 visits in a village in 30 days | INFO |

Thresholds are deliberately simple and explicit. An alert nobody can explain is an alert
nobody acts on.

### Symptom trends

`GET /dashboard/symptom-trends` compares the requested window against the immediately
preceding window of equal length, so "rising" always means like-for-like.

Three thresholds shape what it reports, and each exists to stop the endpoint producing
noise that reads as signal:

| Threshold | Value | Why |
|---|---|---|
| Signal floor | 5 occurrences | Below this the movement label is withheld and reported as `STEADY`. Two cases becoming three is "+50%", which is arithmetic, not an outbreak. The percentage is still returned. |
| Movement band | ±25% | Screening volume itself varies with how many days a CHW worked, so smaller swings usually describe the CHW's week rather than the village's health. |
| Village minimum cell | 5 | Village counts below this are omitted and tallied in `villagesSuppressed`. A rare symptom in a small village can identify one household, and the district total does not need that resolution to be actionable. |

`direction` is one of `RISING`, `FALLING`, `STEADY` or `NEW` (`NEW` meaning no occurrences
in the previous window). `changePct` is `null` when there is no prior baseline to divide by.

**These are symptoms, not diagnoses.** The system never records a diagnosis, so it cannot
report one. A rise can also mean more screening rather than more illness, and the dashboard
says so on the page.

---

## 11. Awareness content

### `GET /api/v1/awareness`
`awareness:read`. Filters: `language`, `category`, `includeInactive` (administrators
only). Returns the full body text and `audioPath`, so a device can cache everything for
offline use.

### `PUT /api/v1/awareness/:id`
`awareness:manage`. Upserts a topic. Audited.

---

## 12. Users

### `GET /api/v1/users`
`user:manage`. Filters: `role`, `status`, `village`. **Never returns a password hash** —
the row mapper does not read that column, so it cannot be serialised by accident.

### `POST /api/v1/users`
`user:manage`. **409** if the username is taken; **400** with field errors if the
password fails the policy (at least 8 characters, not digits only, not a repeated
character, not on the common list).

### `PATCH /api/v1/users/:id`
`user:manage`. Updates any field, including `password`. **409** when the change would
suspend or demote the **last active administrator** — an administrator must not be able
to lock the system out of itself.

---

## 13. Audit

### `GET /api/v1/audit`
`audit:read`. Filters: `action`, `userId`, `entityType`, `from`, `to`, `page`,
`pageSize` (max 200).

The audit log records **actions, never clinical content**. Patient names, vitals and
symptoms are excluded by a scrubbing function applied to every metadata write, because
an audit log holding the data it protects is a second, less protected copy of the health
record.

Reading the audit log is itself audited (`AUDIT_VIEW`).

Recorded actions: `LOGIN_SUCCESS`, `LOGIN_FAILURE`, `LOGOUT`, `PATIENT_CREATE`,
`PATIENT_UPDATE`, `PATIENT_VIEW`, `PATIENT_LIST`, `VISIT_CREATE`, `TRIAGE_RECORD`,
`REFERRAL_CREATE`, `REFERRAL_UPDATE`, `SYNC_PUSH`, `USER_CREATE`, `USER_UPDATE`,
`RULESET_PUBLISH`, `AWARENESS_UPDATE`, `AUDIT_VIEW`.

---


---

## 14. Reference data

### `GET /api/v1/reference/villages`
Distinct villages, for filter dropdowns.

### `GET /api/v1/reference/facilities`
Distinct referral destinations already in use, offered as suggestions so spelling stays
consistent across CHWs.

---

## 15. Worked example: a complete offline encounter

```bash
# 1. Sign in (once, online)
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"chw1","password":"DemoPass2026"}' | jq -r .token)

# 2. ... the CHW works offline for a day; nothing touches the network ...

# 3. Back in coverage, the device pushes what it captured
curl -s -X POST http://localhost:4000/api/v1/sync \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "clientTime": "2026-09-18T08:05:12.000Z",
    "items": [
      { "entityType":"patient", "entityId":"b4192cb9-38d1-47de-87cd-320df34ac815",
        "operation":"CREATE",
        "idempotencyKey":"patient:b4192cb9-38d1-47de-87cd-320df34ac815:CREATE:1",
        "payload":{ "id":"b4192cb9-38d1-47de-87cd-320df34ac815", "localId":"P-RFA2",
                    "firstName":"Sarah", "lastName":"Nakimuli", "age":52, "sex":"FEMALE",
                    "village":"Kasangati", "phone":"+256772000000",
                    "consentStatus":"GRANTED", "createdBy":"<chw-uuid>",
                    "createdAt":"2026-09-18T07:40:00.000Z",
                    "updatedAt":"2026-09-18T07:40:00.000Z", "version":1 } }
    ]
  }' | jq .data.summary

# 4. Send the identical batch again — the server stores exactly one copy
#    and answers DUPLICATE.
```
