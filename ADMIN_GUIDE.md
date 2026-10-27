# Administrator and Health Official Guide

For administrators, nurses and district officials using the web dashboard.

---

## 1. Signing in

Open the dashboard URL and sign in with your username and password.

The dashboard is for facility and district staff. A CHW account is refused with an
explanation, because every page here requires a permission a CHW does not hold.

Your session is held for the browser tab only and is discarded when the browser closes —
dashboards are often opened on shared facility computers, and a session that outlives
the person who signed in is a problem.

---

## 2. What each role sees

| | CHW app | Overview & analytics | Villages | CHW activity | Referrals | Users | Rules | Audit |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **CHW** | ✅ | | | | own only | | | |
| **Nurse / health officer** | | ✅ | ✅ | ✅ | ✅ act | | | |
| **District official** | | ✅ | ✅ | ✅ | | | | |
| **Administrator** | | ✅ | ✅ | ✅ | ✅ view | ✅ | ✅ | ✅ |

### The privacy boundary

A **district official sees aggregate figures only** — counts, rates and trends. They
never see a patient's name, phone number or clinical detail.

This is not a matter of hidden menu items. The endpoints an official can reach are
written so they cannot return identifiable data, and a test asserts it: every aggregate
endpoint is called with an official's token and checked against names that are known to
be in the database.

A **nurse** sees patient identities, because a referral cannot be acted on without them.

---

## 3. Overview

The landing page, covering a period you choose (7, 30 or 90 days, or 12 months).

**The figures**

| | |
|---|---|
| Patients screened | Distinct patients registered in the period |
| Screenings | Visits recorded |
| Active CHWs | CHWs who recorded at least one visit |
| Urgent (RED) | Screenings that found danger signs needing referral |
| Follow-up (AMBER) | Screenings needing a follow-up or further assessment |
| No danger signs | GREEN screenings |
| Referrals pending | Created but not yet acknowledged by a facility |
| Follow-ups open | Referrals with a follow-up date still outstanding |

**Triage outcomes over time** stacks RED, AMBER and GREEN so the total height is
screening volume and the RED band sits at the bottom where it is easiest to compare.

**Risk indicators by category** shows how often each group of rules fired. The category
comes from the rule identifier — `HTN` hypertension, `DM` diabetes, `MAT` maternal,
`CHILD` child health, `FEVER`, `MAL` malaria, `RESP` respiratory, `NUT` nutrition.

### Alerts

| Alert | Trigger | Severity |
|---|---|---|
| RED cluster in a village | 4 or more RED results in 30 days | HIGH |
| Referrals pending follow-up | 10 or more pending | MEDIUM (HIGH at 25+) |
| Devices not synchronising | A CHW quiet for over 48 hours | MEDIUM |
| Records rejected | Any rejection in 24 hours | MEDIUM |
| Increased screening activity | 20 or more visits in a village in 30 days | INFO |

The thresholds are deliberately simple and explicit. An alert nobody can explain is an
alert nobody acts on.

---

## 4. Villages and CHW activity

**Villages** ranks villages by RED count, with patients, screenings, the RED/AMBER/GREEN
split, referrals and the **RED rate** (the share of screenings flagged urgent). The RED
rate is the figure to watch: a village with a high rate and low volume may have a
screening-coverage problem rather than a health problem.

**CHW activity** shows each CHW's workload and when their device last synchronised.

> A device that has not synchronised **does not mean lost data.** Records are on the
> phone, encrypted, until it reaches a connection. Check whether the CHW has coverage or
> needs support — do not treat it as a data-loss incident.

---

## 5. Referrals (nurses)

Referrals are listed most urgent first: Immediate, then Within 24 hours, then Routine,
and newest first within each band. Filter by status and urgency.

Each row shows the patient, village, urgency, the triage result that produced it, the
reason, the destination facility and the current status.

**Working a referral**

1. **Acknowledge** when the facility has seen it and is expecting the patient.
2. **Mark seen** when the patient has attended and the referral is complete.

Every change is recorded in the audit log with the old and new status.

---

## 6. Triage rules (administrators)

**This is the most clinically important screen in the system.**

The rules shipped with this build are a **configuration template**. They have not been
approved by any clinical authority, and the dashboard shows a warning saying so, as does
every result screen in the CHW application.

### Before any real use

1. The responsible health authority reviews **every rule**.
2. Thresholds are replaced with those of the **locally approved protocol**.
3. `metadata.approvedBy` and `metadata.approvedOn` are filled in.
4. `rulesetVersion` is raised.
5. The rule set is published.

### How to change a threshold

Thresholds live in configuration, not code. Changing one is a configuration change and
needs no code release.

1. Fetch the current rule set: `GET /api/v1/triage/ruleset`.
2. Edit the JSON — a threshold, a new rule, or `"active": false` to retire one.
3. Raise `rulesetVersion` (publishing the same version twice is refused).
4. Publish: `PUT /api/v1/triage/ruleset`.

The rule set is validated before it is accepted. A malformed one is rejected with the
specific problems listed, and **the active rule set is left untouched** so devices keep
working on a known-good configuration.

Devices pick up the new rules the next time they have a connection, and cache them for
offline use. Each triage result records the `rulesetVersion` that produced it, so months
later it is still possible to say which thresholds were in force when a patient was
screened.

### The shape of a rule

```json
{
  "id": "HTN-RED-01",
  "name": "Raised blood pressure with persistent headache",
  "category": "hypertension",
  "riskLevel": "RED",
  "priority": 95,
  "referralRequired": true,
  "condition": {
    "all": [
      { "fact": "systolicBp", "op": "gte", "value": 160 },
      { "fact": "diastolicBp", "op": "gte", "value": 100 },
      { "fact": "symptom.headache", "op": "present" },
      { "fact": "symptom.headache.durationDays", "op": "gte", "value": 2 }
    ]
  },
  "label": "Very high blood pressure together with a persistent headache",
  "recommendation": "Refer the patient to the health facility immediately…",
  "explanation": "A blood pressure this high combined with a headache…"
}
```

- **Facts:** any vital sign, plus `age`, `sex`, and `symptom.<code>`,
  `symptom.<code>.severity`, `symptom.<code>.durationDays`.
- **Operators:** `gte` `gt` `lte` `lt` `eq` `ne` `between` `in` `present` `absent`.
- **Composition:** `all`, `any`, `not`, nested freely.
- **Combination:** when several rules fire, the **highest** risk level wins — a single
  RED is never diluted by concurrent AMBER findings. Referral is required if any fired
  rule requires it. The recommendation shown comes from the highest-priority fired rule,
  so the CHW is told the most urgent action rather than an average one.
- **Missing facts:** a comparison against a measurement that was not recorded is
  **false**. A CHW with no glucometer must never be told a patient has low blood sugar.

---


---

## 7. Demonstrating the system

A ten-minute script for an examiner or a review meeting.

**Setup:** API and both clients running; database seeded; the CHW app installed on a
phone or open in a browser, signed in and PIN set.

1. **Show the dashboard.** Overview, the triage chart, the alerts. Note the figures.
2. **Turn off the network** — airplane mode on the phone, or stop the API. Stopping the
   API is the stronger demonstration: the network is up and the server is simply gone.
3. **Open the CHW application and unlock with the PIN.** Point out that this is a sign-in
   with no server involved at all.
4. **Register a patient**: Sarah Nakimuli, 52, female, Kasangati. Read the consent statement
   aloud. Save.
5. **Start a screening.** Enter **165 / 100**. Tap **Headache**, Moderate, 3 days.
6. **Tap "Check result".** The screen shows **RED — URGENT REFERRAL** instantly. Read out
   the recommendation and the triggered indicators, and point at the line saying the
   result was ready in under a millisecond with no internet.
7. **Continue to the referral.** Show the prepared text message and point out that it
   contains the patient's first name and where to go — **and nothing clinical**.
8. **Save.** Note the strip: `OFFLINE — n RECORDS SAVED ON THIS PHONE`.
9. **Play a health awareness topic** from Learn — still with no network.
10. **Force-close the application and reopen it.** Unlock. Everything is there.
11. **Restore the network.** Within a moment the strip reads `ONLINE — EVERYTHING SENT`.
12. **Refresh the dashboard.** The patient and the RED screening have arrived. Open
    Referrals; the new referral is at the top, marked Immediate.
13. **Optional, and the strongest point:** send the same batch twice and show that the
    server stores exactly one copy. `tests/api.sync.test.ts` proves this ten times over.
14. **Symptom trends.** Open **Symptom trends** in the dashboard. Show what is rising
    against the previous period, and point out that the figures are symptoms a health
    worker recorded, not diagnoses. Note the villages column: counts below the reporting
    threshold are withheld rather than shown, so a rare symptom cannot single out one
    household.

---

## 8. Operating the system

### Users

**Users & roles** lists every account. Create one with **+ Add user**; choose the role
carefully, since it determines everything the person can see.

Suspend an account rather than deleting it — the audit trail must keep pointing at a
real user. The system refuses to suspend or demote the **last active administrator**, so
it cannot be locked out of itself.

Passwords must be at least 8 characters, not digits only, not a repeated character, and
not on the common-password list. Set an initial password and have the person change it.

### Awareness content

Content is served to devices and cached for offline use. Each topic has a language, a
category, a summary, the body text and an optional audio path.

To add audio, place the file under the CHW application's `public/audio/<language>/` and
set `audioPath` to its path. It is precached by the service worker and plays offline.

**Translations must be reviewed.** The Luganda content shipped with this build is marked
as a draft and is flagged as such in the application. Have a native-speaking health
educator review each translation before it is used in the field.

### Backups and retention

- Back up the PostgreSQL database on a schedule. **Test a restore** — an untested backup
  is a hope, not a backup.
- `audit_logs` and `sync_receipts` grow without bound. Archive both on a retention
  schedule agreed with your information-governance lead. Do not delete sync receipts
  younger than the longest plausible device offline period, or a returning device could
  create duplicates.
- Demonstration data is marked with `DEMO-` in the patient code and can be removed with
  a single query.

### Monitoring

- `GET /health` — liveness.
- `GET /ready` — readiness; confirms the database is reachable.
- The **Synchronisation** page shows records received, rejections, conflicts and quiet
  devices in one place.

---

## 9. Responding to problems

| Situation | What it means | What to do |
|---|---|---|
| A CHW has not synchronised for days | Their records are safe on the phone | Check coverage and that the app is opening. No data is at risk |
| Records rejected during sync | Validation or authorisation failed | Check the audit log for `SYNC_PUSH` entries. The records are still on the device |
| Conflicts reported | A device offered an older version of a record | Usually harmless. The server's newer copy stands |
| A village shows a RED cluster | 4 or more urgent results in 30 days | Review those referrals. Consider whether it is a real cluster, a measurement problem, or one CHW screening a high-risk group |
| A CHW forgot their PIN | The device cannot be unlocked | The phone must be set up again. **Any records not yet synchronised are lost** — check the Synchronisation page first to see what was outstanding |
| A patient asks for their data to be removed | A consent withdrawal | Set `consentStatus` to `WITHDRAWN` and follow your information-governance procedure |
| Someone reports a wrong triage result | A rule may be wrong for your setting | Note the `rulesetVersion` on that result, review the rule with the clinical authority, and publish a corrected version |
