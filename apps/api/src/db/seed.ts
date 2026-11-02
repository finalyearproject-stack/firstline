/**
 * Demo data seeder (spec s27).
 *
 * EVERY RECORD CREATED BY THIS SCRIPT IS FICTIONAL. The names, villages, phone numbers
 * and clinical readings are invented for demonstration and testing. No real patient
 * information is used anywhere in this repository. Seeded patients carry the marker
 * `DEMO-` in their local id so demonstration data can always be told apart from real
 * data at a glance and removed with a single query.
 *
 * The generator is deterministic: it is driven by a fixed-seed pseudo-random sequence,
 * so the same demo appears on every machine and an examiner sees the same figures the
 * report describes.
 */
import {
  AWARENESS_SEED,
  uuid,
  type ConsentStatus,
  type Patient,
  type Referral,
  type ScreeningFocus,
  type Sex,
  type Symptom,
  type TriageResult,
  type Urgency,
  type Visit,
  type VitalSigns,
} from '@rhm/shared';
import { DEFAULT_RULESET, runTriage, SYMPTOM_CATALOGUE } from '@rhm/triage';
import { createDb, fromBool, type Db } from './index.ts';
import { migrate, isEntryPoint } from './migrate.ts';
import { hashPassword } from '../auth/passwords.ts';
import {
  upsertPatient,
  upsertReferral,
  upsertSymptom,
  upsertTriage,
  upsertVisit,
  upsertVitals,
} from '../services/repositories.ts';

/** Deterministic PRNG (mulberry32) so the demo is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20260918);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const between = (lo: number, hi: number): number => Math.round(lo + random() * (hi - lo));
const chance = (p: number): boolean => random() < p;

// Parishes and trading centres in Uganda's Central Region. The region is chosen to match
// the Luganda awareness content; a deployment elsewhere replaces both together.
const VILLAGES = ['Kasangati', 'Kiwoko', 'Kalagi', 'Nakifuma', 'Bombo', 'Ngoma'];

// Names are kept in per-sex lists so the generated demo records are internally
// consistent. A record reading "Samuel, female" is fictional either way, but it looks
// like a data-quality defect to anyone reviewing the dashboard.
//
// SURNAMES are split by sex too, which the previous name set did not need. Luganda
// surnames are gendered: the "Na-" and "Nam-" forms are women's names. Drawing from one
// shared pool would generate "Moses Nakimuli", which reads as broken data to any Ugandan
// reviewer — exactly the defect the per-sex split above exists to avoid.
const FEMALE_NAMES = [
  'Nakato', 'Babirye', 'Namazzi', 'Aisha', 'Sarah', 'Grace', 'Proscovia', 'Harriet',
  'Betty', 'Sylvia', 'Justine', 'Immaculate', 'Rehema', 'Florence',
];

const MALE_NAMES = [
  'Kato', 'Wasswa', 'Moses', 'Joseph', 'Patrick', 'Emmanuel', 'Godfrey', 'Ronald',
  'Fred', 'Ivan', 'Julius', 'Isaac', 'Denis', 'Robert',
];

const FEMALE_SURNAMES = [
  'Nakimuli', 'Namusoke', 'Nabukenya', 'Nalwoga', 'Nakabugo', 'Namutebi',
  'Nassolo', 'Nabbosa', 'Nakayiza', 'Namaganda',
];

const MALE_SURNAMES = [
  'Mukasa', 'Kigozi', 'Lubega', 'Ssempala', 'Kiggundu', 'Wamala',
  'Musoke', 'Kayondo', 'Ssentamu', 'Bukenya', 'Ddumba', 'Sserwadda',
];

// Uganda grades its facilities HC II / III / IV below hospital level, and referrals are
// made to a named level. Using that nomenclature rather than a generic "Health Post"
// keeps the referral messages recognisable to the people who receive them.
const FACILITIES = [
  'Kasangati Health Centre IV',
  'Kiwoko Health Centre III',
  'Nakifuma Health Centre III',
  'Bombo Health Centre IV',
];

export interface SeedSummary {
  users: number;
  patients: number;
  visits: number;
  referrals: number;
  awareness: number;
  triage: { RED: number; AMBER: number; GREEN: number };
}

export async function seed(db: Db, log: (msg: string) => void = console.log): Promise<SeedSummary> {
  const now = Date.now();
  const iso = (offsetDays: number, hour = 9): string =>
    new Date(now - offsetDays * 86_400_000 + hour * 3_600_000).toISOString();

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  //
  // Demo passwords are intentionally obvious and are printed at the end of the run.
  // They exist so an examiner can sign in immediately. A production deployment seeds
  // no users at all; the first administrator is created by the operator.
  const DEMO_PASSWORD = 'DemoPass2026';

  const userSpecs = [
    { username: 'admin',   name: 'System Administrator', role: 'ADMIN'    as const, village: null,      chw: null },
    { username: 'nurse',   name: 'Sister Proscovia Nalwoga', role: 'NURSE'    as const, village: 'Kasangati', chw: null },
    { username: 'officer', name: 'District Officer Kigozi',  role: 'OFFICIAL' as const, village: null,        chw: null },
    { username: 'chw1',    name: 'Sarah Nakimuli',           role: 'CHW'      as const, village: 'Kasangati', chw: 'VHT-001' },
    { username: 'chw2',    name: 'Moses Mukasa',             role: 'CHW'      as const, village: 'Nakifuma',  chw: 'VHT-002' },
    { username: 'chw3',    name: 'Grace Namusoke',           role: 'CHW'      as const, village: 'Kiwoko',    chw: 'VHT-003' },
    { username: 'chw4',    name: 'Patrick Lubega',           role: 'CHW'      as const, village: 'Bombo',     chw: 'VHT-004' },
  ];

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const userIds = new Map<string, string>();

  for (const spec of userSpecs) {
    // Drawn BEFORE the early return below. The generator's determinism claim depends on
    // consuming the same number of random values on every run, and skipping an existing
    // user must not change how far the sequence has advanced — otherwise re-seeding an
    // existing database produces different figures from seeding a fresh one.
    const phone = `+25677000${between(1000, 9999)}`;

    const existing = await db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', [
      spec.username,
    ]);
    const id = existing?.id ?? uuid();
    userIds.set(spec.username, id);

    if (existing) continue;

    await db.run(
      'INSERT INTO users (id, name, phone, username, password_hash, role, chw_identifier, village, status, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id, spec.name, phone, spec.username, passwordHash,
        spec.role, spec.chw, spec.village, 'ACTIVE', iso(120), iso(120),
      ],
    );
  }

  const chws = userSpecs.filter((u) => u.role === 'CHW');
  log(`  users: ${userSpecs.length}`);

  // -------------------------------------------------------------------------
  // Awareness content
  // -------------------------------------------------------------------------
  for (const item of AWARENESS_SEED) {
    await db.run(
      'INSERT INTO awareness_content (id, title, language, category, summary, body, audio_path, version, active, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body,' +
        '  summary = excluded.summary, version = excluded.version, updated_at = excluded.updated_at',
      [
        item.id, item.title, item.language, item.category, item.summary, item.body,
        item.audioPath, item.version, fromBool(item.active), iso(60),
      ],
    );
  }
  log(`  awareness content: ${AWARENESS_SEED.length}`);

  // -------------------------------------------------------------------------
  // Triage rule set
  // -------------------------------------------------------------------------
  const ruleSetExists = await db.get('SELECT id FROM triage_rulesets WHERE version = ?', [
    DEFAULT_RULESET.rulesetVersion,
  ]);
  if (!ruleSetExists) {
    await db.run(
      'INSERT INTO triage_rulesets (id, version, definition, active, approved_by, approved_on, created_by, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        uuid(), DEFAULT_RULESET.rulesetVersion, JSON.stringify(DEFAULT_RULESET),
        fromBool(true), null, null, userIds.get('admin') ?? null, iso(90),
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Patients, visits, screenings
  // -------------------------------------------------------------------------
  const counts = { RED: 0, AMBER: 0, GREEN: 0 };
  let visitCount = 0;
  let referralCount = 0;
  const PATIENT_COUNT = 360;

  for (let i = 0; i < PATIENT_COUNT; i += 1) {
    const chw = pick(chws);
    const chwId = userIds.get(chw.username)!;
    const village = chw.village ?? pick(VILLAGES);

    // A realistic age mix: mostly adults, with a meaningful share of under-fives so the
    // paediatric rules are exercised by the demo data.
    const age = chance(0.22) ? between(0, 4) : between(16, 82);
    const sex: Sex = chance(0.56) ? 'FEMALE' : 'MALE';
    // Weighted towards the last 30 days, the dashboard's default window, so every chart
    // has enough data to read while the older registrations still give trends a history.
    const registeredDaysAgo = chance(0.6) ? between(1, 30) : between(31, 85);

    const patient: Patient = {
      id: uuid(),
      serverId: null,
      localId: `DEMO-${String(i + 1).padStart(4, '0')}`,
      firstName: pick(sex === 'FEMALE' ? FEMALE_NAMES : MALE_NAMES),
      lastName: pick(sex === 'FEMALE' ? FEMALE_SURNAMES : MALE_SURNAMES),
      age,
      sex,
      village,
      phone: chance(0.65) ? `+2567${between(10000000, 89999999)}` : null,
      consentStatus: (chance(0.96) ? 'GRANTED' : 'DECLINED') as ConsentStatus,
      createdBy: chwId,
      createdAt: iso(registeredDaysAgo),
      updatedAt: iso(registeredDaysAgo),
      version: 1,
      syncStatus: 'SYNCED',
    };
    await upsertPatient(db, patient);

    // One to four visits per patient, always within the 30-day analytics window for at
    // least the most recent one, so the dashboard has something to show.
    const visits = between(1, 4);
    for (let v = 0; v < visits; v += 1) {
      // Later visits follow the registration forward in time. One that would fall in the
      // future is skipped, not moved to today: clamping piled them all onto the last day
      // and drew a false spike at the end of every screening-volume chart.
      const daysAgo = registeredDaysAgo - v * between(5, 20);
      if (daysAgo < 0) break;
      const visitId = uuid();

      // Drawn before the visit so its screening focus can follow from them: a VHT who
      // finds a feverish child screens for fever, a pregnant woman gets an antenatal check.
      const band = random();
      const isAdult = age >= 16;
      const feverish = chance(0.18);
      const pregnantVisit = sex === 'FEMALE' && age >= 16 && age <= 45 && chance(0.18);
      const focus: ScreeningFocus = pregnantVisit
        ? 'PREGNANCY'
        : age < 5
          ? (chance(0.7) ? 'CHILD' : feverish ? 'FEVER' : 'COUGH')
          : feverish && chance(0.7)
            ? 'FEVER'
            : isAdult && band > 0.72 && chance(0.6)
              ? 'BLOOD_PRESSURE'
              : pick(['GENERAL', 'GENERAL', 'COUGH', 'BLOOD_PRESSURE'] as const);

      const visit: Visit = {
        id: visitId,
        patientId: patient.id,
        chwId,
        visitDate: iso(daysAgo, between(8, 17)),
        village,
        notes: chance(0.3) ? 'Routine household screening visit.' : null,
        focus,
        createdAt: iso(daysAgo),
        updatedAt: iso(daysAgo),
        version: 1,
        syncStatus: 'SYNCED',
      };
      await upsertVisit(db, visit);
      visitCount += 1;

      // Vitals. A deliberate minority of readings are in the raised and severe bands so
      // the demo contains real RED and AMBER cases rather than only healthy screenings.
      const systolic = !isAdult
        ? between(90, 110)
        : band > 0.9
          ? between(165, 195)
          : band > 0.72
            ? between(142, 164)
            : between(105, 135);
      const diastolic = !isAdult
        ? between(55, 72)
        : band > 0.9
          ? between(100, 122)
          : band > 0.72
            ? between(90, 99)
            : between(65, 85);

      // Kit measurements, taken when the focus calls for them (MUAC for under-fives,
      // a malaria test for fever, weeks for a pregnancy), as a VHT would.
      const muacTaken = focus === 'CHILD' && chance(0.85);
      const rdtTaken = (focus === 'FEVER' || (focus === 'CHILD' && feverish)) && chance(0.85);

      const vitals: VitalSigns = {
        id: uuid(),
        visitId,
        systolicBp: systolic,
        diastolicBp: diastolic,
        temperatureC: feverish ? Number((38 + random() * 1.9).toFixed(1)) : Number((36.2 + random() * 1).toFixed(1)),
        weightKg: isAdult ? between(45, 92) : between(4, 18),
        pulseBpm: feverish ? between(95, 125) : between(58, 92),
        oxygenSaturation: chance(0.45) ? (chance(0.03) ? between(84, 89) : between(94, 99)) : null,
        respiratoryRate: chance(0.5) ? (feverish ? between(22, 30) : between(14, 20)) : null,
        bloodGlucoseMmol: chance(0.25)
          ? (chance(0.15) ? Number((11.5 + random() * 9).toFixed(1)) : Number((4.2 + random() * 2.5).toFixed(1)))
          : null,
        muacColour: muacTaken ? (chance(0.05) ? 'RED' : chance(0.13) ? 'YELLOW' : 'GREEN') : null,
        malariaRdt: rdtTaken ? (chance(feverish ? 0.5 : 0.15) ? 'POSITIVE' : 'NEGATIVE') : null,
        oedema: focus === 'CHILD' ? chance(0.02) : null,
        pregnancyWeeks: pregnantVisit ? between(8, 38) : null,
        recordedAt: visit.visitDate,
        syncStatus: 'SYNCED',
      };
      await upsertVitals(db, vitals);

      // Symptoms
      const symptoms: Symptom[] = [];
      const symptomPool = SYMPTOM_CATALOGUE.filter((s) => {
        if (s.code === 'pregnant') return false; // recorded only on pregnancy visits, below
        if (['unable_to_feed', 'vomits_everything'].includes(s.code)) return age < 5;
        return true;
      });

      const symptomCount = chance(0.25) ? 0 : between(1, 3);
      const chosen = new Set<string>();
      for (let s = 0; s < symptomCount; s += 1) {
        const def = pick(symptomPool);
        if (chosen.has(def.code)) continue;
        chosen.add(def.code);

        symptoms.push({
          id: uuid(),
          visitId,
          symptomCode: def.code,
          symptomName: def.name,
          severity: pick(['MILD', 'MODERATE', 'SEVERE'] as const),
          durationDays: def.asksDuration ? between(1, 21) : null,
          syncStatus: 'SYNCED',
        });
      }
      if (pregnantVisit) {
        symptoms.push({
          id: uuid(), visitId, symptomCode: 'pregnant', symptomName: 'Pregnant',
          severity: 'MILD', durationDays: null, syncStatus: 'SYNCED',
        });
      }
      if (feverish && !chosen.has('fever_felt')) {
        symptoms.push({
          id: uuid(), visitId, symptomCode: 'fever_felt', symptomName: 'Feels feverish',
          severity: 'MODERATE', durationDays: between(1, 5), syncStatus: 'SYNCED',
        });
      }
      for (const symptom of symptoms) await upsertSymptom(db, symptom);

      // Triage: computed by the real engine, never fabricated, so the demo figures are
      // internally consistent with the rules an examiner can read.
      const outcome = runTriage(
        {
          age,
          sex,
          systolicBp: vitals.systolicBp,
          diastolicBp: vitals.diastolicBp,
          temperatureC: vitals.temperatureC,
          pulseBpm: vitals.pulseBpm,
          oxygenSaturation: vitals.oxygenSaturation,
          respiratoryRate: vitals.respiratoryRate,
          bloodGlucoseMmol: vitals.bloodGlucoseMmol,
          muacColour: vitals.muacColour,
          malariaRdt: vitals.malariaRdt,
          oedema: vitals.oedema,
          pregnancyWeeks: vitals.pregnancyWeeks,
          symptoms: symptoms.map((s) => ({
            symptomCode: s.symptomCode,
            severity: s.severity,
            durationDays: s.durationDays,
          })),
        },
        DEFAULT_RULESET,
      );

      const triage: TriageResult = {
        id: uuid(),
        visitId,
        riskLevel: outcome.riskLevel,
        triggeredRules: outcome.triggeredRules,
        triggeredLabels: outcome.triggeredLabels,
        recommendation: outcome.recommendation,
        referralRequired: outcome.referralRequired,
        rulesetVersion: outcome.rulesetVersion,
        evaluationMs: outcome.evaluationMs,
        createdAt: visit.visitDate,
        syncStatus: 'SYNCED',
      };
      await upsertTriage(db, triage);
      counts[outcome.riskLevel] += 1;

      // Referrals follow the triage result rather than being sprinkled at random.
      if (outcome.referralRequired || (outcome.riskLevel === 'AMBER' && chance(0.35))) {
        const urgency: Urgency =
          outcome.riskLevel === 'RED' ? 'IMMEDIATE' : chance(0.5) ? 'WITHIN_24H' : 'ROUTINE';

        const completed = chance(0.45);
        const referral: Referral = {
          id: uuid(),
          patientId: patient.id,
          visitId,
          destination: pick(FACILITIES),
          urgency,
          reason: outcome.triggeredLabels[0] ?? 'Further assessment required.',
          status: completed ? 'COMPLETED' : chance(0.4) ? 'ACKNOWLEDGED' : 'PENDING',
          followUpDate: new Date(Date.parse(visit.visitDate) + 7 * 86_400_000)
            .toISOString()
            .slice(0, 10),
          notes: null,
          createdBy: chwId,
          createdAt: visit.visitDate,
          completedAt: completed
            ? new Date(Date.parse(visit.visitDate) + between(4, 96) * 3_600_000).toISOString()
            : null,
          version: 1,
          syncStatus: 'SYNCED',
        };
        await upsertReferral(db, referral);
        referralCount += 1;
      }
    }
  }

  log(`  patients: ${PATIENT_COUNT}`);
  log(`  visits: ${visitCount}  (RED ${counts.RED} / AMBER ${counts.AMBER} / GREEN ${counts.GREEN})`);
  log(`  referrals: ${referralCount}`);

  // Sync receipts, so the dashboard's sync-monitoring panel has history to show.
  for (const chw of chws) {
    const id = userIds.get(chw.username)!;
    const hoursAgo = chw.username === 'chw4' ? 72 : between(1, 20);
    await db.run(
      'INSERT INTO sync_receipts (idempotency_key, user_id, entity_type, entity_id, operation, result_status, received_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING',
      [
        `demo-seed:${id}`, id, 'patient', uuid(), 'CREATE', 'APPLIED',
        new Date(now - hoursAgo * 3_600_000).toISOString(),
      ],
    );
  }

  return {
    users: userSpecs.length,
    patients: PATIENT_COUNT,
    visits: visitCount,
    referrals: referralCount,
    awareness: AWARENESS_SEED.length,
    triage: counts,
  };
}

/** Removes every demo record, leaving real data untouched. */
export async function clearDemoData(db: Db): Promise<void> {
  await db.run("DELETE FROM patients WHERE local_id LIKE 'DEMO-%'");
}

if (isEntryPoint(import.meta.url)) {
  const db = await createDb();
  console.log(`Seeding demo data (${db.dialect})...`);
  await migrate(db, () => {});
  const summary = await seed(db);
  await db.close();

  console.log('');
  console.log('All seeded records are FICTIONAL demonstration data.');
  console.log('');
  console.log('Sign in with any of these accounts (password: DemoPass2026):');
  console.log('  admin    - administrator');
  console.log('  nurse    - nurse / health officer');
  console.log('  officer  - district official (aggregate view only)');
  console.log('  chw1..4  - community health workers');
  console.log('');
  console.log(`Summary: ${JSON.stringify(summary)}`);
}
