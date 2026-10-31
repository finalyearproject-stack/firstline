-- Migration 002: screening focus and VHT kit measurements
--
-- Adds what a VHT records with the tools the MoH VHT guidelines (2010) put in the kit:
-- the MUAC tape reading, a malaria rapid test result, swelling of both feet, and the
-- weeks of pregnancy, plus the focus the VHT chose for the screening.
--
-- Every new column is nullable with no default. Rows written before this migration,
-- and uploads from phones running an older app version, simply leave them empty, and
-- the triage engine treats an empty measurement as "not taken", never as normal.

ALTER TABLE visits ADD COLUMN focus {{TEXT}};

ALTER TABLE vital_signs ADD COLUMN muac_colour {{TEXT}};
ALTER TABLE vital_signs ADD COLUMN malaria_rdt {{TEXT}};
ALTER TABLE vital_signs ADD COLUMN oedema {{BOOL}};
ALTER TABLE vital_signs ADD COLUMN pregnancy_weeks {{INT}};

CREATE INDEX IF NOT EXISTS idx_visits_focus ON visits (focus, visit_date);
