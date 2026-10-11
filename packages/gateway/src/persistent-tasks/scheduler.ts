import type { WorkbenchService } from '../workbench/service.ts';
import type { PersistentTaskService } from './service.ts';

/** Cleanup never depends on host readiness. Autonomous admission does. */
export async function maintainWorkbench(
  workbench: Pick<WorkbenchService, 'resumeDeletions' | 'processMailbox'> & Partial<Pick<WorkbenchService,'reconcileBudgets'>>,
  tasks: Pick<PersistentTaskService, 'tick'> & Partial<Pick<PersistentTaskService,'maintainNotifications'>>,
  executionReady: boolean,
) {
  const cleanup = workbench.resumeDeletions();
  workbench.reconcileBudgets?.();
  tasks.maintainNotifications?.();
  if (executionReady !== true) return { execution_ready: false, cleanup };
  workbench.processMailbox();
  return { execution_ready: true, cleanup, tasks: await tasks.tick() };
}
