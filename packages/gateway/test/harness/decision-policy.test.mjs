import assert from 'node:assert/strict';
import test from 'node:test';

import { decideNext } from '../../src/harness/decision-policy.ts';

const budget = { remaining_ms: 60_000, attempts_remaining: 2, alternative_tools: ['exa'] };

test('deterministic goal rejection is corrected without sleeping', () => {
  const decision = decideNext({ status: 'rejected', failure_class: 'goal_contract', transience: 'deterministic', reason_code: 'CONSTRAINT_SCOPE_UNRESOLVED' }, budget, []);
  assert.deepEqual(decision, { action: 'continue', reason: 'correct_goal_delta' });
});

test('temporary upstream failure may wait when retry hint fits the Harness budget', () => {
  const decision = decideNext({ status: 'failed', failure_class: 'upstream', transience: 'temporary', reason_code: 'UPSTREAM_TIMEOUT', upstream_hint: { retry_after_ms: 2500 } }, { ...budget, alternative_tools: [] }, []);
  assert.deepEqual(decision, { action: 'wait', delay_ms: 2500, reason: 'temporary_upstream' });
});

test('rate limit selects another tool instead of blindly sleeping', () => {
  const decision = decideNext({ status: 'failed', failure_class: 'rate_limit', transience: 'temporary', reason_code: 'PROVIDER_RATE_LIMITED', upstream_hint: { retry_after_ms: 300000 } }, budget, []);
  assert.deepEqual(decision, { action: 'switch_tool', tool: 'exa', reason: 'provider_rate_limited' });
});

test('three identical failure fingerprints stop the loop', () => {
  const history = Array(3).fill({ failure_class: 'upstream', reason_code: 'UPSTREAM_TIMEOUT', call_fingerprint: 'same' });
  const decision = decideNext({ status: 'failed', failure_class: 'upstream', transience: 'temporary', reason_code: 'UPSTREAM_TIMEOUT', call_fingerprint: 'same' }, budget, history);
  assert.deepEqual(decision, { action: 'stop', reason: 'repeated_failure_cycle' });
});
