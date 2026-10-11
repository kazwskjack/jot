export interface TaskGoalStatus {
  protocol: 1;
  host_status: 'idle' | 'running';
  goal: { goal_id: string; goal_revision: number; phase: 'active' | 'paused' | 'blocked' | 'complete';
    activation: 'armed' | 'disarmed'; rounds_started: number; max_goal_rounds: number };
  task: { run_status: string; business_state: string;
    steps: { total: number; completed: number; evidence_verified: number; all_completed: boolean; all_execution_evidence_verified: boolean };
    budget: { configured: boolean; balances: Array<{ scope_id: string;
      limits: Amounts; used: Amounts; held: Amounts }>;
      pending_unknown: number | null; pending_in_flight: number | null } };
}
type Amounts = { tokens: string; nano_usd: string; model_calls: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown): value is number => integer(value) && value > 0;
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}

/** Private authenticated host facts. Neither Goal phase nor execution receipts
 * certify acceptance, authorize effects, or grant another round. */
export function validateTaskGoalStatus(response: unknown, prior?: TaskGoalStatus): TaskGoalStatus {
  const invalid = (): never => { throw new Error('goal_status_invalid'); };
  if (!record(response, ['state'])) return invalid();
  const state = response.state;
  if (!record(state, ['protocol', 'host_status', 'goal', 'task']) || state.protocol !== 1
    || typeof state.host_status !== 'string' || !['idle', 'running'].includes(state.host_status)) return invalid();
  const goal = state.goal;
  if (!record(goal, ['goal_id', 'goal_revision', 'phase', 'activation', 'rounds_started', 'max_goal_rounds'])
    || typeof goal.goal_id !== 'string' || !ID.test(goal.goal_id) || !positive(goal.goal_revision)
    || !positive(goal.max_goal_rounds) || !integer(goal.rounds_started) || goal.rounds_started > goal.max_goal_rounds
    || typeof goal.phase !== 'string' || !['active', 'paused', 'blocked', 'complete'].includes(goal.phase)
    || typeof goal.activation !== 'string' || !['armed', 'disarmed'].includes(goal.activation)) return invalid();
  const task = state.task;
  if (!record(task, ['run_status', 'business_state', 'steps', 'budget'])
    || typeof task.run_status !== 'string' || !['queued', 'starting', 'running', 'waiting_user', 'waiting_approval'].includes(task.run_status)
    || typeof task.business_state !== 'string' || !/^[a-z_]{1,64}$/.test(task.business_state)) return invalid();
  const steps = task.steps;
  if (!record(steps, ['total', 'completed', 'evidence_verified', 'all_completed', 'all_execution_evidence_verified'])
    || !integer(steps.total) || !integer(steps.completed) || !integer(steps.evidence_verified)
    || steps.completed > steps.total || steps.evidence_verified > steps.completed
    || steps.all_completed !== (steps.total > 0 && steps.completed === steps.total)
    || steps.all_execution_evidence_verified !== (steps.total > 0 && steps.evidence_verified === steps.total)) return invalid();
  const budget = task.budget;
  if (!record(budget, ['configured', 'balances', 'pending_unknown', 'pending_in_flight'])
    || typeof budget.configured !== 'boolean' || !Array.isArray(budget.balances) || budget.balances.length > 8) return invalid();
  if (!budget.configured) {
    if (budget.balances.length || budget.pending_unknown !== null || budget.pending_in_flight !== null) return invalid();
  } else {
    if (!budget.balances.length || !integer(budget.pending_unknown) || !integer(budget.pending_in_flight)) return invalid();
    const ids = new Set();
    for (const balance of budget.balances) {
      if (!record(balance, ['scope_id', 'limits', 'used', 'held']) || typeof balance.scope_id !== 'string'
        || !ID.test(balance.scope_id) || ids.has(balance.scope_id)) return invalid();
      ids.add(balance.scope_id);
      for (const key of ['limits', 'used', 'held']) {
        const amounts = balance[key];
        if (!record(amounts, ['tokens', 'nano_usd', 'model_calls'])
          || !Object.values(amounts).every(value => typeof value === 'string' && /^(0|[1-9][0-9]{0,127})$/.test(value))) return invalid();
      }
    }
  }
  if (prior && (goal.goal_id !== prior.goal.goal_id || goal.goal_revision < prior.goal.goal_revision
    || goal.rounds_started < prior.goal.rounds_started || goal.max_goal_rounds !== prior.goal.max_goal_rounds)) return invalid();
  return structuredClone(state) as unknown as TaskGoalStatus;
}

export function taskGoalStopReason(state: TaskGoalStatus, managed: boolean): string | undefined {
  const {goal, task} = state;
  if (task.run_status === 'waiting_user') return 'SESSION_GOAL_WAITING_USER';
  if (task.run_status === 'waiting_approval') return 'SESSION_GOAL_WAITING_APPROVAL';
  if (task.budget.configured && task.budget.pending_unknown! > 0) return 'SESSION_GOAL_USAGE_UNKNOWN';
  if (goal.phase === 'paused') {
    if (task.business_state === 'input_requested') return 'SESSION_GOAL_WAITING_USER';
    if (task.business_state === 'approval_requested') return 'SESSION_GOAL_WAITING_APPROVAL';
    return 'SESSION_GOAL_PAUSED';
  }
  if (goal.phase === 'blocked') return 'SESSION_GOAL_BLOCKED';
  // Completion proposals still need the separate acceptance controller. Never
  // promote a native lifecycle label to a business certificate here.
  if (goal.phase === 'complete') return 'SESSION_GOAL_REVIEW_REQUIRED';
  if (!managed) return undefined;
  if (!task.budget.configured) return 'SESSION_GOAL_BUDGET_UNCONFIGURED';
  if (task.budget.pending_in_flight! > 0) {
    // The next native round may already be streaming when a queued prior
    // turn/end is consumed. Its reserved upper bound is normal active usage;
    // stopping it here would cancel a paid call solely because it is running.
    // Actual per-step/stream admission still enforces the budget. Unknown
    // fees and explicit stopped lifecycle states above remain blocking.
    return state.host_status === 'idle' ? 'SESSION_GOAL_USAGE_PENDING' : undefined;
  }
  if (state.host_status === 'idle' && goal.rounds_started >= goal.max_goal_rounds) return 'SESSION_GOAL_ROUND_LIMIT';
  for (const balance of task.budget.balances) {
    for (const key of ['tokens', 'nano_usd', 'model_calls'] as const) {
      if (BigInt(balance.used[key]) + BigInt(balance.held[key]) >= BigInt(balance.limits[key])) return 'SESSION_GOAL_BUDGET_EXHAUSTED';
    }
  }
  if (goal.activation === 'disarmed' && state.host_status === 'idle') return 'SESSION_GOAL_DISARMED';
  return undefined;
}
