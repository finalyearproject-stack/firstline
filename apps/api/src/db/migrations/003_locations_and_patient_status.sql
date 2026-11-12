-- Migration 003: where each village sits, and each patient's care status
--
-- Locations. Uganda's local government runs district > sub-county (or town council)
-- > parish (or ward) > village. Patients and visits already record their village as
-- text, so this table places each village name in that hierarchy without changing the
-- phone app or the sync protocol. A village name must therefore be unique here; a later
-- version would store a location id on the patient itself.
--
-- Patient status. A nurse sets each patient's status individually from the dashboard.
-- Every change is a new row, never an update, so the history of who set what and when
-- is kept; the current status is the latest row. It lives apart from `patients`, whose
-- version counter belongs to the phone that registered the patient: a nurse's change
-- must never turn the VHT's next upload into a sync conflict.

CREATE TABLE IF NOT EXISTS locations (
  village     {{TEXT}} PRIMARY KEY,
  parish      {{TEXT}} NOT NULL,
  sub_county  {{TEXT}} NOT NULL,
  district    {{TEXT}} NOT NULL,
  created_at  {{TS}} NOT NULL,
  updated_at  {{TS}} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locations_hierarchy ON locations (district, sub_county, parish);

CREATE TABLE IF NOT EXISTS patient_status_events (
  id          {{PK}} PRIMARY KEY,
  patient_id  {{PK}} NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  status      {{TEXT}} NOT NULL CHECK (status IN ('AWAITING_ARRIVAL','SEEN','ON_TREATMENT','REFERRED_ON','RECOVERED','LOST_TO_FOLLOW_UP')),
  note        {{TEXT}},
  set_by      {{PK}} NOT NULL REFERENCES users (id),
  set_at      {{TS}} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patient_status_patient ON patient_status_events (patient_id, set_at);
