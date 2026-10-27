import defaultRules from './rules/clinical-rules.json' with { type: 'json' };
import type { RuleSet } from './types.ts';

export * from './types.ts';
export * from './engine.ts';
export * from './symptoms.ts';

/**
 * The rule set shipped with the application.
 *
 * Treated as a default, not a constant: the API serves the active rule set from the
 * database so an administrator can change thresholds without a code release, and the
 * CHW client caches whatever it last received. This export is the fallback used on
 * first run, before any rule set has been fetched.
 */
export const DEFAULT_RULESET = defaultRules as unknown as RuleSet;
