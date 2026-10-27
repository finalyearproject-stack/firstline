/**
 * Deterministic, offline triage rule engine.
 *
 * Design constraints (spec s8):
 *   - No network. No AI model. No I/O of any kind.
 *   - Same input always yields the same output.
 *   - Thresholds live in configuration, never in this file.
 *
 * Missing-fact policy: a comparison against a fact that was not recorded evaluates to
 * FALSE rather than throwing. A CHW without a glucometer must not trigger — nor
 * silently suppress — a glucose rule. `absent` is the one operator that treats a
 * missing fact as a match, because that is precisely what it asks about.
 */
import type { RiskLevel, Severity } from '@rhm/shared';
import type {
  Condition,
  FiredRule,
  Leaf,
  Rule,
  RuleSet,
  TriageFacts,
  TriageOutcome,
} from './types.ts';

const RISK_ORDER: Record<RiskLevel, number> = { GREEN: 0, AMBER: 1, RED: 2 };
const SEVERITY_ORDER: Record<Severity, number> = { MILD: 0, MODERATE: 1, SEVERE: 2 };

function isLeaf(node: Condition): node is Leaf {
  return typeof (node as Leaf).fact === 'string';
}

/**
 * Resolves a fact path to a comparable value.
 * Returns `undefined` when the fact was not recorded.
 */
export function resolveFact(
  facts: TriageFacts,
  path: string,
): number | string | boolean | undefined {
  if (path.startsWith('symptom.')) {
    const rest = path.slice('symptom.'.length);
    const [code, attribute] = rest.split('.');
    const match = facts.symptoms?.find(
      (s) => s.symptomCode.toLowerCase() === code.toLowerCase(),
    );

    if (!attribute) return match ? true : undefined;
    if (!match) return undefined;

    if (attribute === 'severity') return match.severity ?? undefined;
    if (attribute === 'durationDays') return match.durationDays ?? undefined;
    return undefined;
  }

  const value = (facts as Record<string, unknown>)[path];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

/** Severity strings are ordinal, so they compare like numbers. */
function comparable(value: number | string | boolean): number | string {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value in SEVERITY_ORDER) {
    return SEVERITY_ORDER[value as Severity];
  }
  return value;
}

function evaluateLeaf(facts: TriageFacts, leaf: Leaf): boolean {
  const raw = resolveFact(facts, leaf.fact);

  if (leaf.op === 'absent') return raw === undefined;
  if (raw === undefined) return false;
  if (leaf.op === 'present') return true;

  const actual = comparable(raw);

  switch (leaf.op) {
    case 'eq':
      return actual === comparable(leaf.value as number | string | boolean);
    case 'ne':
      return actual !== comparable(leaf.value as number | string | boolean);
    case 'in': {
      const list = (leaf.value as (number | string)[]) ?? [];
      return list.map((v) => comparable(v)).includes(actual);
    }
    case 'between': {
      const [lo, hi] = (leaf.value as number[]) ?? [];
      return typeof actual === 'number' && actual >= lo && actual <= hi;
    }
    case 'gte':
    case 'gt':
    case 'lte':
    case 'lt': {
      const expected = comparable(leaf.value as number | string);
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      if (leaf.op === 'gte') return actual >= expected;
      if (leaf.op === 'gt') return actual > expected;
      if (leaf.op === 'lte') return actual <= expected;
      return actual < expected;
    }
    default:
      return false;
  }
}

export function evaluateCondition(facts: TriageFacts, node: Condition): boolean {
  if (isLeaf(node)) return evaluateLeaf(facts, node);
  if ('all' in node) return node.all.every((child) => evaluateCondition(facts, child));
  if ('any' in node) return node.any.some((child) => evaluateCondition(facts, child));
  if ('not' in node) return !evaluateCondition(facts, node.not);
  return false;
}

/**
 * Runs every active rule and combines the results.
 *
 * Combination policy:
 *   - Overall risk is the HIGHEST risk level among fired rules. A single RED is never
 *     diluted by concurrent GREEN or AMBER findings.
 *   - Referral is required if ANY fired rule requires it.
 *   - The displayed recommendation comes from the highest-priority fired rule at the
 *     overall risk level, so the CHW is told the most urgent action, not an average.
 */
export function runTriage(facts: TriageFacts, ruleSet: RuleSet): TriageOutcome {
  const started = now();

  const fired: FiredRule[] = [];
  for (const rule of ruleSet.rules) {
    if (rule.active === false) continue;
    if (!evaluateCondition(facts, rule.condition)) continue;
    fired.push(toFired(rule));
  }

  // Most urgent first, then highest priority, then stable by id.
  fired.sort(
    (a, b) =>
      RISK_ORDER[b.riskLevel] - RISK_ORDER[a.riskLevel] ||
      b.priority - a.priority ||
      a.id.localeCompare(b.id),
  );

  const riskLevel: RiskLevel = fired.length
    ? fired[0].riskLevel
    : ruleSet.defaultResult.riskLevel;

  const recommendation = fired.length
    ? fired[0].recommendation
    : ruleSet.defaultResult.recommendation;

  return {
    riskLevel,
    referralRequired: fired.some((r) => r.referralRequired),
    recommendation,
    firedRules: fired,
    triggeredRules: fired.map((r) => r.id),
    triggeredLabels: fired.map((r) => r.label),
    rulesetVersion: ruleSet.rulesetVersion,
    evaluationMs: now() - started,
  };
}

function toFired(rule: Rule): FiredRule {
  return {
    id: rule.id,
    name: rule.name,
    category: rule.category,
    riskLevel: rule.riskLevel,
    label: rule.label,
    recommendation: rule.recommendation,
    explanation: rule.explanation,
    referralRequired: rule.referralRequired,
    priority: rule.priority,
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const VALID_OPS = new Set([
  'gte', 'gt', 'lte', 'lt', 'eq', 'ne', 'between', 'in', 'present', 'absent',
]);

function validateCondition(node: Condition | undefined, where: string): string[] {
  if (!node) return [where + ': condition is required'];

  if (isLeaf(node)) {
    const errors: string[] = [];
    if (!node.fact) errors.push(where + ': leaf is missing a fact');
    if (!VALID_OPS.has(node.op)) errors.push(where + ': unknown operator ' + node.op);
    if (node.op === 'between') {
      const v = node.value;
      if (!Array.isArray(v) || v.length !== 2) {
        errors.push(where + ': "between" needs a [min, max] array');
      }
    } else if (node.op !== 'present' && node.op !== 'absent' && node.value === undefined) {
      errors.push(where + ': operator ' + node.op + ' needs a value');
    }
    return errors;
  }

  if ('all' in node) return node.all.flatMap((c) => validateCondition(c, where));
  if ('any' in node) return node.any.flatMap((c) => validateCondition(c, where));
  if ('not' in node) return validateCondition(node.not, where);
  return [where + ': unrecognised condition node'];
}

/**
 * Structural validation of a rule set loaded from configuration.
 *
 * Run at application start and whenever an administrator uploads a new rule file, so a
 * malformed edit fails loudly at load rather than silently mis-triaging a patient.
 */
export function validateRuleSet(ruleSet: RuleSet): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  if (!ruleSet.rulesetVersion) errors.push('rulesetVersion is required');
  if (!ruleSet.defaultResult?.recommendation) {
    errors.push('defaultResult.recommendation is required');
  }

  for (const rule of ruleSet.rules ?? []) {
    const where = 'rule ' + (rule.id || '(missing id)');
    if (!rule.id) errors.push('a rule is missing an id');
    else if (seen.has(rule.id)) errors.push('duplicate rule id: ' + rule.id);
    else seen.add(rule.id);

    if (!(rule.riskLevel in RISK_ORDER)) errors.push(where + ': invalid riskLevel');
    if (typeof rule.priority !== 'number') errors.push(where + ': priority must be a number');
    if (!rule.label) errors.push(where + ': label is required');
    if (!rule.recommendation) errors.push(where + ': recommendation is required');
    errors.push(...validateCondition(rule.condition, where));
  }

  return errors;
}
