export interface OutcomeFact {
  status: string;
  failure_class: string | null;
  transience: string;
  reason_code: string | null;
  upstream_hint?: { retry_after_ms?: number } | null;
  call_fingerprint?: string;
}

export interface HarnessBudget {
  remaining_ms: number;
  attempts_remaining: number;
  alternative_tools: string[];
}

export type HarnessDecision =
  | { action: 'continue'; reason: string }
  | { action: 'wait'; delay_ms: number; reason: string }
  | { action: 'switch_tool'; tool: string; reason: string }
  | { action: 'ask_user'; reason: string }
  | { action: 'stop'; reason: string };

export function decideNext(outcome: OutcomeFact, budget: HarnessBudget, history: OutcomeFact[]): HarnessDecision {
  const repeats = history.filter(item =>
    item.failure_class === outcome.failure_class
    && item.reason_code === outcome.reason_code
    && item.call_fingerprint === outcome.call_fingerprint,
  ).length;
  if (repeats >= 3) return { action: 'stop', reason: 'repeated_failure_cycle' };
  if (outcome.failure_class === 'goal_contract' && outcome.transience === 'deterministic') {
    return { action: 'continue', reason: 'correct_goal_delta' };
  }
  if (outcome.transience === 'external_action_required') {
    return { action: 'ask_user', reason: String(outcome.reason_code || 'external_action_required').toLowerCase() };
  }
  if (outcome.failure_class === 'rate_limit' && budget.alternative_tools.length > 0) {
    return { action: 'switch_tool', tool: budget.alternative_tools[0]!, reason: 'provider_rate_limited' };
  }
  if (outcome.transience === 'temporary' && budget.attempts_remaining > 0) {
    const requested = outcome.upstream_hint?.retry_after_ms ?? 1000;
    if (requested <= Math.min(30_000, budget.remaining_ms / 2)) {
      return { action: 'wait', delay_ms: Math.max(100, requested), reason: 'temporary_upstream' };
    }
    if (budget.alternative_tools.length > 0) {
      return { action: 'switch_tool', tool: budget.alternative_tools[0]!, reason: 'temporary_upstream' };
    }
  }
  return { action: 'stop', reason: 'budget_or_recovery_exhausted' };
}
