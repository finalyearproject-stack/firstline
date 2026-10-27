-- Migration 001: initial schema
--
-- Written once, rendered for both dialects by the migration runner. The {{TOKENS}}
-- below are replaced with dialect-appropriate types (see db/migrate.ts), so PostgreSQL
-- and SQLite can never drift apart into two hand-maintained schemas.
--
--   {{PK}}   -> primary key column type (UUID text in both dialects)
--   {{TEXT}} -> variable-length text
--   {{INT}}  -> 32-bit integer
--   {{REAL}} -> floating point
--   {{BOOL}} -> boolean (SMALLINT under SQLite, BOOLEAN under PostgreSQL)
--   {{TS}}   -> ISO-8601 timestamp stored as text, for lossless client/server round-trip
--   {{JSON}} -> serialised JSON stored as text

CREATE TABLE IF NOT EXISTS users (
  id              {{PK}} PRIMARY KEY,
  name            {{TEXT}} NOT NULL,
  phone           {{TEXT}},
  username        {{TEXT}} NOT NULL UNIQUE,
  password_hash   {{TEXT}} NOT NULL,
  role            {{TEXT}} NOT NULL CHECK (role IN ('CHW','NURSE','OFFICIAL','ADMIN')),
  chw_identifier  {{TEXT}},
  village         {{TEXT}},
  status          {{TEXT}} NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at      {{TS}} NOT NULL,
  updated_at      {{TS}} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role    ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_village ON users (village);

CREATE TABLE IF NOT EXISTS patients (
  id              {{PK}} PRIMARY KEY,
  local_id        {{TEXT}} NOT NULL,
  first_name      {{TEXT}} NOT NULL,
  last_name       {{TEXT}} NOT NULL,
  age             {{INT}}  NOT NULL CHECK (age >= 0 AND age <= 130),
  sex             {{TEXT}} NOT NULL CHECK (sex IN ('FEMALE','MALE','OTHER')),
  village         {{TEXT}} NOT NULL,
  phone           {{TEXT}},
  consent_status  {{TEXT}} NOT NULL CHECK (consent_status IN ('GRANTED','DECLINED','WITHDRAWN')),
  created_by      {{PK}} NOT NULL REFERENCES users (id),
  created_at      {{TS}} NOT NULL,
  updated_at      {{TS}} NOT NULL,
  -- Monotonic per-record counter. A sync upload carrying a version older than the
  -- stored one is a conflict, not an update (see services/sync.ts).
  version         {{INT}} NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_patients_village    ON patients (village);
CREATE INDEX IF NOT EXISTS idx_patients_created_by ON patients (created_by);
CREATE INDEX IF NOT EXISTS idx_patients_name       ON patients (last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_patients_local_id   ON patients (local_id);

CREATE TABLE IF NOT EXISTS visits (
  id          {{PK}} PRIMARY KEY,
  patient_id  {{PK}} NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  chw_id      {{PK}} NOT NULL REFERENCES users (id),
  visit_date  {{TS}} NOT NULL,
  village     {{TEXT}} NOT NULL,
  notes       {{TEXT}},
  created_at  {{TS}} NOT NULL,
  updated_at  {{TS}} NOT NULL,
  version     {{INT}} NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits (patient_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_chw     ON visits (chw_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_date    ON visits (visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_village ON visits (village, visit_date);

CREATE TABLE IF NOT EXISTS vital_signs (
  id                 {{PK}} PRIMARY KEY,
  -- One vitals record per visit; the unique constraint makes a duplicated sync upload
  -- fail loudly at the database rather than quietly double-recording a blood pressure.
  visit_id           {{PK}} NOT NULL UNIQUE REFERENCES visits (id) ON DELETE CASCADE,
  systolic_bp        {{INT}},
  diastolic_bp       {{INT}},
  temperature_c      {{REAL}},
  weight_kg          {{REAL}},
  pulse_bpm          {{INT}},
  oxygen_saturation  {{INT}},
  respiratory_rate   {{INT}},
  blood_glucose_mmol {{REAL}},
  recorded_at        {{TS}} NOT NULL
);

CREATE TABLE IF NOT EXISTS symptoms (
  id            {{PK}} PRIMARY KEY,
  visit_id      {{PK}} NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
  symptom_code  {{TEXT}} NOT NULL,
  symptom_name  {{TEXT}} NOT NULL,
  severity      {{TEXT}} NOT NULL CHECK (severity IN ('MILD','MODERATE','SEVERE')),
  duration_days {{INT}},
  UNIQUE (visit_id, symptom_code)
);

CREATE INDEX IF NOT EXISTS idx_symptoms_visit ON symptoms (visit_id);
CREATE INDEX IF NOT EXISTS idx_symptoms_code  ON symptoms (symptom_code);

CREATE TABLE IF NOT EXISTS triage_results (
  id                {{PK}} PRIMARY KEY,
  visit_id          {{PK}} NOT NULL UNIQUE REFERENCES visits (id) ON DELETE CASCADE,
  risk_level        {{TEXT}} NOT NULL CHECK (risk_level IN ('RED','AMBER','GREEN')),
  triggered_rules   {{JSON}} NOT NULL,
  triggered_labels  {{JSON}} NOT NULL,
  recommendation    {{TEXT}} NOT NULL,
  referral_required {{BOOL}} NOT NULL,
  ruleset_version   {{TEXT}} NOT NULL,
  evaluation_ms     {{REAL}} NOT NULL,
  created_at        {{TS}} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_triage_risk    ON triage_results (risk_level, created_at);
CREATE INDEX IF NOT EXISTS idx_triage_created ON triage_results (created_at);

CREATE TABLE IF NOT EXISTS referrals (
  id             {{PK}} PRIMARY KEY,
  patient_id     {{PK}} NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  visit_id       {{PK}} NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
  destination    {{TEXT}} NOT NULL,
  urgency        {{TEXT}} NOT NULL CHECK (urgency IN ('IMMEDIATE','WITHIN_24H','ROUTINE')),
  reason         {{TEXT}} NOT NULL,
  status         {{TEXT}} NOT NULL CHECK (status IN ('PENDING','ACKNOWLEDGED','COMPLETED','CANCELLED')),
  follow_up_date {{TEXT}},
  notes          {{TEXT}},
  created_by     {{PK}} NOT NULL REFERENCES users (id),
  created_at     {{TS}} NOT NULL,
  completed_at   {{TS}},
  version        {{INT}} NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_referrals_status   ON referrals (status, created_at);
CREATE INDEX IF NOT EXISTS idx_referrals_patient  ON referrals (patient_id);
CREATE INDEX IF NOT EXISTS idx_referrals_followup ON referrals (follow_up_date);
CREATE INDEX IF NOT EXISTS idx_referrals_urgency  ON referrals (urgency, status);

CREATE TABLE IF NOT EXISTS awareness_content (
  id         {{PK}} PRIMARY KEY,
  title      {{TEXT}} NOT NULL,
  language   {{TEXT}} NOT NULL,
  category   {{TEXT}} NOT NULL,
  summary    {{TEXT}} NOT NULL,
  body       {{TEXT}} NOT NULL,
  audio_path {{TEXT}},
  version    {{INT}} NOT NULL DEFAULT 1,
  active     {{BOOL}} NOT NULL DEFAULT 1,
  updated_at {{TS}} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_awareness_lang ON awareness_content (language, category);
CREATE INDEX IF NOT EXISTS idx_awareness_live ON awareness_content (active);

-- The triage rule set is stored, not hard-coded, so an administrator can change
-- thresholds through configuration without a code release (spec s8).
CREATE TABLE IF NOT EXISTS triage_rulesets (
  id          {{PK}} PRIMARY KEY,
  version     {{TEXT}} NOT NULL UNIQUE,
  definition  {{JSON}} NOT NULL,
  active      {{BOOL}} NOT NULL DEFAULT 0,
  approved_by {{TEXT}},
  approved_on {{TEXT}},
  created_by  {{PK}} REFERENCES users (id),
  created_at  {{TS}} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rulesets_active ON triage_rulesets (active);

-- Server-side record of every sync operation already applied.
--
-- This single table is what makes synchronisation idempotent: the unique constraint on
-- idempotency_key means a retried upload — from a dropped connection, a crashed app, or
-- an impatient CHW — can never create a second copy of a record (spec s12).
CREATE TABLE IF NOT EXISTS sync_receipts (
  idempotency_key {{TEXT}} PRIMARY KEY,
  user_id         {{PK}} NOT NULL REFERENCES users (id),
  entity_type     {{TEXT}} NOT NULL,
  entity_id       {{PK}} NOT NULL,
  operation       {{TEXT}} NOT NULL,
  result_status   {{TEXT}} NOT NULL,
  received_at     {{TS}} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_entity ON sync_receipts (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_receipts_user   ON sync_receipts (user_id, received_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          {{PK}} PRIMARY KEY,
  user_id     {{PK}} REFERENCES users (id),
  action      {{TEXT}} NOT NULL,
  entity_type {{TEXT}} NOT NULL,
  entity_id   {{TEXT}},
  timestamp   {{TS}} NOT NULL,
  metadata    {{JSON}},
  ip_address  {{TEXT}}
);

CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_logs (user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_logs (timestamp);
