/**
 * Triage rule engine types.
 *
 * The engine is deliberately a pure, synchronous, dependency-free function over plain
 * data. It performs no I/O, makes no network call and consults no model, so it behaves
 * identically on a phone in airplane mode and on the server (spec s8).
 */
import type { MuacColour, RdtResult, RiskLevel, Severity, Sex, Urgency } from '@rhm/shared';

/** Comparison operators available to a rule condition. */
export type Operator =
  | 'gte'
  | 'gt'
  | 'lte'
  | 'lt'
  | 'eq'
  | 'ne'
  | 'between'
  | 'in'
  | 'present'
  | 'absent';

/**
 * A single test against one fact.
 *
 * `fact` is either a vitals/demographic field name, or a symptom-scoped path:
 *   - `symptom.headache`               -> presence of the symptom
 *   - `symptom.headache.severity`      -> its severity
 *   - `symptom.headache.durationDays`  -> how long it has been present
 */
export interface Leaf {
  fact: string;
  op: Operator;
  value?: number | string | boolean | (number | string)[];
}

export interface AllNode {
  all: Condition[];
}
export interface AnyNode {
  any: Condition[];
}
export interface NotNode {
  not: Condition;
}

export type Condition = Leaf | AllNode | AnyNode | NotNode;

export interface Rule {
  /** Stable identifier recorded on every triage result for auditability. */
  id: string;
  name: string;
  category: string;
  riskLevel: RiskLevel;
  /**
   * Higher wins when several rules fire. The recommendation shown to the CHW comes
   * from the highest-priority fired rule.
   */
  priority: number;
  referralRequired: boolean;
  /**
   * How soon a referral should happen. Optional: a RED rule means IMMEDIATE and any
   * other referring rule ROUTINE unless it says otherwise (e.g. WHO's "go to the
   * health centre as soon as possible" signs in pregnancy are WITHIN_24H).
   */
  referralUrgency?: Urgency;
  condition: Condition;
  /** Plain-language indicator shown in the "Triggered indicators" list. */
  label: string;
  recommendation: string;
  /** Why this rule exists; shown when the CHW taps "Why?". */
  explanation: string;
  active?: boolean;
}

export interface RuleSet {
  rulesetVersion: string;
  /** Provenance and the clinical-authority disclaimer. Displayed in the admin UI. */
  metadata: {
    name: string;
    disclaimer: string;
    source: string;
    approvedBy: string | null;
    approvedOn: string | null;
  };
  /** Result used when no rule fires. */
  defaultResult: {
    riskLevel: RiskLevel;
    recommendation: string;
  };
  rules: Rule[];
}

/** Facts assembled from a visit's vitals and symptoms, fed to the engine. */
export interface TriageFacts {
  age?: number | null;
  sex?: Sex | null;
  systolicBp?: number | null;
  diastolicBp?: number | null;
  temperatureC?: number | null;
  weightKg?: number | null;
  pulseBpm?: number | null;
  oxygenSaturation?: number | null;
  respiratoryRate?: number | null;
  bloodGlucoseMmol?: number | null;
  muacColour?: MuacColour | null;
  malariaRdt?: RdtResult | null;
  oedema?: boolean | null;
  pregnancyWeeks?: number | null;
  symptoms?: Array<{
    symptomCode: string;
    severity?: Severity | null;
    durationDays?: number | null;
  }>;
}

export interface FiredRule {
  id: string;
  name: string;
  category: string;
  riskLevel: RiskLevel;
  label: string;
  recommendation: string;
  explanation: string;
  referralRequired: boolean;
  referralUrgency: Urgency | null;
  priority: number;
}

export interface TriageOutcome {
  riskLevel: RiskLevel;
  referralRequired: boolean;
  /** The most urgent referral any fired rule asks for; null when none refers. */
  referralUrgency: Urgency | null;
  recommendation: string;
  firedRules: FiredRule[];
  triggeredRules: string[];
  triggeredLabels: string[];
  rulesetVersion: string;
  /** Wall-clock evaluation time; asserted against the 1 s target in spec s21. */
  evaluationMs: number;
}
