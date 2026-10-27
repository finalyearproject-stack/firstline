# SECURITY.md

Security posture of the Offline-First Mobile Health Monitoring System: what is
implemented, how, and — just as importantly — what is not.

Health information is among the most sensitive data a person has. Where a control is
partial, this document says so rather than implying more protection than exists.

---

## 1. Threat model

Who this system is defended against, in the order these threats actually occur in a
rural deployment:

| # | Threat | Realistic? | Defence |
|---|---|---|---|
| T1 | **A phone is lost or stolen** | Very — it is the most likely incident | PIN app lock; patient identifiers AES-256-GCM encrypted at rest; key derived from the PIN and never stored |
| T2 | **Someone picks up an unattended, unlocked phone** | Very | Manual lock; the key is dropped from memory on lock |
| T3 | **Network interception** on a shared or hostile connection | Likely | TLS 1.2+ for all API traffic; HSTS in production; no clinical data ever sent by SMS |
| T4 | **A user acts outside their role** — an official looking up a neighbour | Likely | Server-side RBAC on every route; aggregate-only queries for officials; every access audited |
| T5 | **Credential guessing** against a known CHW account | Likely | scrypt password hashing; per-IP+username rate limiting; generic failure messages; PIN attempt limiting |
| T6 | **A forged or tampered token** | Possible | HS256 with constant-time verification; `alg` pinned; `alg: none` refused; issuer and expiry checked |
| T7 | **Injection through captured field data** | Possible | Parameterised SQL everywhere; Zod validation at the trust boundary; no string-built queries |
| T8 | **A malicious or buggy client floods the server** | Possible | Rate limiting; 2 MB body cap; 200-item sync batch cap |
| T9 | **Data loss through duplicate or replayed uploads** | Certain to be attempted by the system itself | Idempotency keys; per-item receipts; version conflict detection |
| T10 | **An insider reads records they have no relationship with** | Possible | Ownership scoping in SQL; 404 rather than 403 to avoid confirming existence; audit trail |
| T11 | **Re-identification from aggregate reporting** | Likely in small villages | Dashboard access is role-gated to district and facility staff; village-level symptom counts are suppressed below n=5, and the aggregate queries cannot return a patient identity |
| T14 | **Enumeration of other people's reports** | Possible | 10-character random reference codes; the status endpoint returns progress only, never content |

**Explicitly out of scope** for this MVP: a rooted or malware-infected device; an
attacker who has the CHW's PIN; a compromised server host; and a state-level adversary.
These need device management, hardware-backed keys and infrastructure controls beyond
what an application can provide.

---

## 2. Authentication

### Passwords

**scrypt** from `node:crypto` — a memory-hard KDF, available without a native build
step, and an appropriate choice for password storage.

```
scrypt$<cost>$<saltHex>$<keyHex>
```

- Cost 2^15 in production (2^12 in tests so the suite is not dominated by key
  derivation), r = 8, p = 1, 64-byte output.
- A random 16-byte salt per password, so identical passwords produce different hashes.
- The cost is stored **in the hash**, so it can be raised later without invalidating
  existing credentials.
- Verification is constant-time (`timingSafeEqual`).
- A corrupt stored hash returns `false` rather than throwing: a bad row must fail the
  login, not crash the endpoint.

**Policy** (`passwordProblems`): at least 8 characters, not digits only, not a single
repeated character, not on a common-password list. Deliberately length-led rather than
composition-led — a long passphrase is easier for a CHW to remember and harder to guess
than a short string with a mandatory punctuation mark.

### Username enumeration

A wrong password, an unknown username and a suspended account all return the same 401
with the same message. The unknown-username path still performs a scrypt verification
against a dummy hash **derived at the configured cost**, so response timing does not
reveal which usernames exist. (A dummy hash eight times cheaper than a real one would
advertise the unknown-username case precisely as loudly as skipping verification.)

### Tokens

HS256 JWTs, implemented directly over `node:crypto` rather than pulled from a library:
the surface needed is one signing algorithm and one verification path, and hand-rolling
it keeps the supply-chain surface of a health system smaller.

The verification path refuses what has historically broken JWT libraries:

- `alg` must be exactly `HS256` — `none` and any algorithm substitution are rejected
  before the signature is examined.
- The signature is compared with `timingSafeEqual` on equal-length buffers.
- The issuer must match; the expiry must be in the future.
- Any malformed input returns a typed failure rather than throwing.

**Secret management.** `JWT_SECRET` is required in production and must be at least 32
characters; the process refuses to start without it. A fallback secret in a health
system is a backdoor with a changelog entry. In development an ephemeral per-process
secret is generated, so restarting the API invalidates existing tokens — the correct
behaviour for a throwaway key.

**Lifetime.** Seven days by default. Long on purpose: a CHW offline for a week must not
be locked out of the upload path. The compensating control is that the token is sealed
under the device PIN and is only in memory while the device is unlocked.

---

## 3. Authorisation

Four roles, one capability table (`packages/shared/src/rbac.ts`) shared by the clients
and the API so both reason from the same definition.

**The clients hide controls a role cannot operate. That is a usability measure and never
the security boundary.** Every route asserts the permission server-side, and
`tests/api.auth.test.ts` proves it by calling the live routes with each role's token.

Two refinements worth naming:

- **Ownership is scoped in SQL, not filtered afterwards.** A CHW's patient list query
  carries `created_by = ?` in its `WHERE` clause. There is no code path on which another
  CHW's records are loaded and then hidden.
- **404, not 403, for a record the caller may not know exists.** A 403 confirms that a
  patient with that id exists, which is itself information about a person the caller has
  no relationship with.

---

## 4. Encryption in transit

- TLS 1.2+ for all API traffic. Terminate at a reverse proxy; the API sets
  `trust proxy` in production so client IPs in the audit log and the rate limiter are
  correct.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production.
- The CHW client **must** be served over HTTPS: service workers, Web Crypto and
  installability all require a secure context.
- CORS is restricted to configured origins; credentials are not used, since the token
  travels in the `Authorization` header.

### Recommended proxy configuration

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

---

## 5. Encryption at rest — device

Implemented in `apps/chw/src/db/crypto.ts`.

```
PIN (4–12 digits)
  │  PBKDF2-SHA-256, 210,000 iterations, random 16-byte salt
  v
AES-256-GCM key  (non-extractable CryptoKey — page code cannot read the raw bytes)
  │
  ├── seals the identifying fields of each record before they reach IndexedDB
  ├── seals the session token
  └── verified against a small encrypted verifier blob
```

- **AES-256-GCM** authenticates as well as encrypts: a modified record fails to decrypt
  rather than returning altered clinical data. The application shows `(unreadable)`
  instead of dropping the row, so the CHW can see something is wrong and report it.
- A fresh random 96-bit IV per encryption, never reused.
- The PIN itself is **never stored**. Only the salt and the verifier are.
- The key exists only in memory while unlocked, and is dropped on lock.

### What is encrypted

| Encrypted | Left in the clear | Why |
|---|---|---|
| First name, last name, phone | Village, age, sex, dates, risk level, sync state | The clear fields are not identifying without the patient row, and must stay indexable so the app can list and count without holding the key |
| Visit notes | | Free text can contain anything |
| Referral reason and notes | | |
| The session token | | |

### PIN policy and attempt limiting

4–12 digits; a repeated single digit and the obvious sequences are refused. Four digits
is the familiar pattern for a device used one-handed in the field; the real protection
against guessing is the attempt limiter, which locks the unlock screen after 10 failures
and tells the CHW to contact their supervisor. Records remain safe and encrypted.

### Biometric unlock

Where the device offers a platform authenticator, WebAuthn is used as a convenience gate
in front of a PIN already entered this session. **WebAuthn does not return key
material**, so biometrics cannot replace the PIN as the source of the encryption key.
This is a deliberate limitation, not an oversight.

### Storage persistence

`navigator.storage.persist()` is requested at sign-in. Without it a browser under
storage pressure may evict IndexedDB — which here would mean losing patient records that
have not yet synchronised.

---

## 6. Honest limits of at-rest encryption

This protects a device that is **lost, stolen, or inspected while locked**. It does not
protect against:

- Malware or a malicious extension running inside the browser profile while the app is
  unlocked. The key and the decrypted records are in memory — unavoidable for any
  application that has to display the data.
- An attacker who knows or observes the PIN.
- A rooted device where another process can read the browser's memory.
- Forensic recovery of pages swapped to disk by the operating system.

A native application with a hardware-backed keystore would raise the bar on the last
two. That is a genuine advantage of the Kotlin route that the PWA does not match, and it
is recorded here rather than glossed over.

---

## 7. Encryption at rest — server

Not implemented at the application layer. Use the platform:

- PostgreSQL with encrypted storage (filesystem-level, LUKS, or a managed provider's
  encryption at rest).
- Encrypted, access-controlled backups.
- TLS for the database connection (`PGSSLMODE=verify-full` with `PGSSLROOTCERT` where
  the provider supplies a CA).

Application-layer column encryption on the server was considered and rejected for this
MVP: it would break the aggregate queries the dashboard depends on, and the realistic
threat to a server is host compromise, which column encryption with a key on the same
host does not address.

---

## 8. Input validation

Zod schemas in `packages/shared/src/schemas.ts` are the **single definition** of what
valid means. The client validates with them before writing to the local database, and
the API validates with them again at the trust boundary. Client-side validation is a
usability feature; the server-side pass is the control, and it never assumes the client
ran first.

- Physiological bounds reject transcription errors (a systolic of 1650) without
  rejecting genuine field extremes.
- A cross-field refinement requires systolic > diastolic.
- Sync payloads are validated against the per-entity schema **after** the entity type is
  known, and the id in the envelope must match the id in the payload — otherwise the
  record would be stored under an identity the receipt does not cover.
- All SQL is parameterised. No query is built by string concatenation with user input.

---

## 9. Safe error handling

- Clients receive a stable `code` and a message safe to display. They never receive a
  stack trace, a SQL fragment or a driver message.
- The server logs full detail to its own console, with patient data omitted.
- In development only, the first line of the error is echoed to speed up debugging.
- `body-parser` failures (malformed JSON, oversized body) are mapped to 400 and 413
  rather than 500. This matters operationally: a CHW client treats 5xx as "the server is
  broken, retry later" and would requeue a payload that will never be accepted. *(This
  was a real defect found by `tests/api.clinical.test.ts` and fixed.)*

---

## 10. Audit logging

Every sensitive operation is recorded: who, what action, which entity, when, from where.

**What is deliberately excluded:** patient names, vital signs, symptoms, diagnoses,
free-text notes, referral reasons, passwords and tokens. `scrubMetadata()` drops any
metadata key matching a blocklist of clinical and identifying field names, enforced in
code rather than left to each caller to remember.

An audit log containing the health data it is protecting would be a second copy of the
sensitive record with weaker access controls around it.

Reading the audit log is itself audited. Audit writes never break the clinical operation
they record: a failed insert is logged to the console and the request proceeds — losing
an audit line is bad, losing a patient record is worse.

---

## 11. Rate limiting

| Bucket | Window | Limit | Key |
|---|---|---|---|
| Sign-in | 15 min | 10 | IP + username |
| General API | 1 min | 600 | IP |

The general limit is generous on purpose: a CHW returning from a week offline pushes a
lot in a short burst, and treating that as an attack would be a data-loss risk.

**Known limitation:** the limiter is per-process. Behind a load balancer running several
API instances, each holds its own counters, so the effective limit multiplies by the
instance count. A deployment at that scale should move the counters to Redis.

---


---

## 12. SMS minimisation

SMS is unencrypted, is stored indefinitely by the network operator, and is frequently
read by whoever is holding the handset. It is treated as a public channel.

**Permitted:** the patient's first name, the destination facility, the urgency as a
plain instruction, a date where one applies, and the referral code.

**Never:** diagnosis, risk level, vital signs, symptoms, surname, age or village.

The message is composed by shared code, checked against a forbidden-term list before it
is offered, and handed to the CHW's own SMS app. The application never sends it, so no
patient contact detail passes through a third-party gateway. Two tests assert the
guarantee rather than trusting the template.

---

## 13. Secrets

- No secret is committed. `.env` is git-ignored; `.env.example` documents every variable
  with no values.
- `JWT_SECRET` is required in production and length-checked at startup.
- Demonstration passwords exist only in seeded demo data and are printed by the seeder.
  **A production deployment seeds no users at all**; the first administrator is created
  by the operator.
- Password hashes are never selected into a response: the user row mapper does not read
  that column, so it cannot be serialised by accident. Asserted by a test.

---

## 14. Dependencies

The dependency count is kept deliberately low — every package is a supply-chain surface
in a system holding health data.

| Purpose | Choice | Instead of |
|---|---|---|
| Password hashing | `node:crypto` scrypt | `bcrypt` (native build) |
| JWT | `node:crypto` HMAC (~100 lines) | `jsonwebtoken` |
| Development database | `node:sqlite` (built into Node 24) | `better-sqlite3` (native build) |
| Database access | Hand-written SQL over a thin adapter | An ORM |
| Client state | React context | A state-management library |
| Styling | Plain CSS | A CSS framework |

Run `npm audit` before each release.

---

## 15. Deployment checklist

- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` set to at least 32 random characters, from a secret manager
- [ ] `DATABASE_URL` set; PostgreSQL reachable over TLS
- [ ] TLS 1.2+ terminated at the proxy, HTTP redirected to HTTPS
- [ ] `CORS_ORIGINS` set to the real client origins only
- [ ] CHW client served over HTTPS (service worker and Web Crypto require it)
- [ ] Database encryption at rest enabled on the host or managed service
- [ ] Encrypted, access-controlled, tested backups
- [ ] Audit log retention and archival configured
- [ ] Demo users removed; the first administrator created manually
- [ ] **Triage rules reviewed and approved by the health authority, `approvedBy` set**
- [ ] `npm audit` clean
- [ ] Rate limiting reviewed for the instance count

---

## 16. Reporting a vulnerability

Report privately to the project maintainer or the deploying health authority's
information-governance contact. Do not open a public issue. Include what you did, what
happened, and what you expected.
