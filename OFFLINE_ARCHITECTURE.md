# OFFLINE_ARCHITECTURE.md

How the system keeps working when there is no network — mechanism by mechanism.

---

## 1. The principle, and what it rules out

> The local database is the source of truth for CHW operations. Connectivity determines
> **when** the facility receives data, never whether the CHW can work.

Three consequences follow, and they are the architecture:

1. **No clinical action awaits a network call.** Not registration, not vitals, not
   triage, not referral, not awareness content, not even signing in after the first day.
2. **Nothing is discarded because a send failed.** A failure moves a record back into
   the queue; it never removes it.
3. **The CHW is always told the truth about where their data is.** A connectivity strip
   is present on every screen and states one of four things in plain language.

---

## 2. The five ways this system could lose a patient record

The design is easier to follow as answers to specific failure modes.

| Failure | What would go wrong naively | What this system does |
|---|---|---|
| Phone dies between saving a record and queueing it for upload | Record exists but will never be sent, or is queued but does not exist | Both writes happen in **one IndexedDB transaction** (`repository.ts` → `commit()`). Either both land or neither does |
| Upload succeeds but the response is lost | Client retries; server stores a second copy | Each item carries a deterministic **idempotency key**; the server's `sync_receipts` primary key makes the second write a no-op and answers `DUPLICATE` |
| App force-closed mid-upload | In-flight records lost or stuck forever | Items are marked `SYNCING` but **stay in the queue**. A new process picks them up on next run |
| One malformed record in a batch of 200 | Whole batch rejected, 199 good records requeued forever | Each item is applied in **its own server transaction**; the response is a per-item verdict |
| Server has newer data than the device | Device silently overwrites a correction | Versioned entities are compared; a stale upload is answered `CONFLICT` and the server's copy stands |

---

## 3. The local database

**Dexie over IndexedDB.** IndexedDB is the only browser store that is transactional,
indexed, asynchronous and large enough for the specification's target of 500 patient
profiles and 30 days of visits.

```
patients   id, village, updatedAt, syncStatus, localId
visits     id, patientId, visitDate, syncStatus
vitals     id, visitId
symptoms   id, visitId, symptomCode
triage     id, visitId, riskLevel, createdAt
referrals  id, patientId, visitId, status, followUpDate, syncStatus
queue      id, status, nextAttemptAt, entityType, entityId
awareness  id, language, category, active
meta       key
```

Indexes are chosen for the three questions the app asks constantly: *which of my
patients is this*, *what happened at this visit*, and *what still needs sending*.

### What is encrypted, and why not everything

| Field group | Storage | Reasoning |
|---|---|---|
| Names, phone numbers, visit notes, referral reasons | AES-256-GCM sealed blob (`sec`) | Directly identifying. Encrypted before it reaches IndexedDB |
| Village, age, sex, dates, risk level, sync state | Plain | Not identifying without the patient row, and must stay indexable so the app can list, filter and count without holding the key |

The trade-off is deliberate: encrypting the indexable columns too would mean decrypting
every row to render a list, and would still not hide much — a UUID with a blood pressure
attached identifies nobody.

**Persistence.** Immediately after sign-in the app calls
`navigator.storage.persist()`. Without it, a browser under storage pressure may evict
IndexedDB, which here would mean losing patient records that have not synchronised.

---

## 4. Client-generated identity

Every record's primary key is a **UUIDv4 generated on the device that created it**.

This single decision removes an entire class of offline bugs. There is no
local-id-to-server-id reconciliation, because there is only ever one identifier. A
record has the same identity the moment a CHW creates it in a village with no signal as
it does once it is stored on the server. `Patient.serverId` exists because the
specification lists it, and it is simply set to the same UUID once the server
acknowledges the record — it records *confirmation*, not a different identity.

---

## 5. The outbox

Every local write appends an entry to the `queue` table **inside the same transaction**
as the record itself:

```ts
await commit(async () => {
  await db().patients.put(stored);
  await db().queue.put(queueEntry('patient', id, payload, version));
});
```

A queue entry carries the serialised payload, an idempotency key, a retry count, a
status, the last error, and the epoch time before which it must not be retried.

### The idempotency key

Deterministic, not random:

```
<entityType>:<entityId>:<operation>:<version>
```

Derived rather than generated, so that if the same logical write is enqueued twice — the
app was force-closed mid-enqueue and the write replayed on restart — both attempts
produce the **same key**, and the server stores the record exactly once.

---

## 6. The sync engine

`apps/chw/src/sync/engine.ts`. It runs only while the device is unlocked, because the
session token is sealed under the PIN and a locked device should not be transmitting.

### When it runs

- On the browser's `online` event.
- On a 60-second sweep — because a connection can be nominally "online" and unusable, a
  distinction that matters more in a rural deployment than anywhere else.
- When the earliest backed-off entry becomes due.
- When the CHW taps **Try sending now**.

### What one run does

```
 nextBatch()              up to 50 entries that are due, oldest first
   │
 mark SYNCING             they STAY in the queue — a crash here loses nothing
   │
 POST /api/v1/sync        one request, per-item envelope
   │
   ├── transport failed ──► all entries back to PENDING, retryCount + 1,
   │                        nextAttemptAt = now + backoff.  NOTHING discarded.
   │
   └── per-item verdict
         APPLIED    ──► mark record SYNCED, delete queue entry
         DUPLICATE  ──► same: the server already has it
         CONFLICT   ──► server holds newer data; stop offering ours
         REJECTED   ──► retry with backoff, up to 8 attempts, then park as FAILED
         (missing)  ──► treat as unsent and retry
```

The queue entry is deleted **only** after the server has explicitly accounted for the
record. Anything else — a timeout, a 500, a dropped connection, a response that does not
mention the item — leaves it queued.

### Backoff

Exponential with **full jitter**, base 2 s, capped at 15 minutes:

```ts
const exponential = Math.min(2000 * 2 ** retryCount, 15 * 60_000);
return Math.floor(Math.random() * exponential);
```

The jitter is not decoration. A hundred CHW phones that reconnect when a village
generator starts would otherwise arrive at the server in the same millisecond, fail
together, and retry together.

---

## 7. The server side

`apps/api/src/services/sync.ts`. Four guarantees, each with a specific mechanism:

1. **Idempotent** — `sync_receipts.idempotency_key` is a primary key. A replayed item is
   answered `DUPLICATE` before any work is done.
2. **Partial success** — each item gets its own transaction. One bad record does not
   roll back the other 199.
3. **Ordered** — items are sorted server-side into dependency order
   (`patient → visit → vitals/symptom → triage → referral`), so a client that enqueued
   them out of order still produces a referentially consistent result.
4. **Authorised** — a CHW may push only records they own, checked against the database
   rather than against a field the client asserted about itself.

A subtle but important detail: when storage fails unexpectedly, the server writes **no
receipt**. The client retries, and the retry can still succeed. Losing the record is not
an option; asking for it again is.

---

## 8. Offline sign-in

A device that needed a server round-trip to sign in would fail the very first
requirement on the list: *open the application*.

```
FIRST RUN    CHW signs in once, online. Credentials are verified by the server.
             A PIN is chosen; PBKDF2-SHA-256 (210,000 iterations) derives an
             AES-256 key. The session token is sealed under that key.
             The PIN itself is never stored.

EVERY DAY    The CHW enters the PIN. The key is re-derived and checked against a
             small encrypted verifier. NO NETWORK IS INVOLVED.

LOCKED       The key is dropped from memory. Records stay on the device,
             encrypted and unreadable. Synchronisation stops.
```

Tokens last seven days by default and can be raised. A CHW who has been offline longer
than the token's life can still open the app, screen patients and save records — only
the upload waits for a fresh sign-in.

---

## 9. The application shell

A Workbox service worker precaches the entire application — HTML, JavaScript, CSS,
icons and awareness audio — so a cold start in airplane mode loads from cache and never
waits on a network that is not there.

| Asset | Strategy | Why |
|---|---|---|
| App shell (JS, CSS, HTML) | Precache | Must load with no network at all |
| Awareness audio (`/audio/**.mp3`) | Cache-first, 1 year | Never changes for a given version; must play offline |
| Reference API reads (awareness, rule set) | Network-first, 5 s timeout, 30-day cache | Fresh when possible, still available when not |
| Clinical writes | **Never cached** | They do not go through HTTP at all — they go to IndexedDB and the outbox |

That last row is the important one. The service worker is not what makes this
application work offline; the local database is. The service worker only makes sure the
application itself loads.

---

## 10. Telling the CHW the truth

Spec §20 requires the connectivity state always to be obvious. The strip sits under the
header on every screen and says exactly one of:

```
ONLINE — EVERYTHING SENT
ONLINE — 3 WAITING TO SEND
OFFLINE — 12 RECORDS SAVED ON THIS PHONE
SENDING 7 OF 12 RECORDS…
CANNOT SEND YET — 12 SAVED SAFELY
```

The pending count is read from the database with a Dexie **live query**, not from the
sync engine's last run. This was a real bug found during development: the engine only
knew what it had counted the last time it ran, so a record saved between runs left the
strip claiming everything had been sent — precisely the ambiguity §20 exists to prevent.

Wording is chosen so that no state reads as data loss. "OFFLINE" is always paired with
"SAVED ON THIS PHONE". A failure says "CANNOT SEND YET — SAVED SAFELY".

---

## 11. What is proven, and how

`tests/offline.test.ts` runs the real client stack against the real API over a real
socket. Only `fetch` rejecting is simulated.

| Claim | Test |
|---|---|
| Registers, finds, screens, triages and refers offline | 7 tests under *the CHW can work with no network at all* |
| Never touches the network while offline | *no request is attempted while offline* — asserts zero push calls |
| Survives close and reopen | *keeps every record after the application is closed and reopened* |
| Outbox survives a restart | *keeps the outbox intact across a restart* |
| Survives forced termination mid-sync | *survives a forced termination in the middle of a sync attempt* |
| Survives network failure and server error | two tests, both asserting nothing is lost and nothing reached the server |
| Exactly one copy after sync | *the server receives exactly one copy* |
| Exactly one copy after a lost response | *still receives exactly one copy when the connection drops mid-sync and retries* |
| Bad records are parked, not retried forever | *parks a permanently invalid record* |
| Backoff grows and is capped | *applies exponential backoff with jitter* |
| Names are not readable on disk | 4 tests under *encryption at rest* |
| 500 patients within budget | *stores and searches 500 patients within the performance budget* |

The "restart" in these tests is a genuine one: the Dexie handle is closed and a fresh
instance is opened over the same store, which is what a force-close and relaunch does.
