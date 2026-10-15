import type { WorkbenchService } from '../workbench/service.ts';
import type { PersistentTaskService } from './service.ts';

/** Cleanup never depends on host readiness. Autonomous admission does. */
export async function maintainWorkbench(
  workbench: Pick<WorkbenchService, 'resumeDeletions' | 'processMailbox'> & Partial<Pick<WorkbenchService,'reconcileBudgets' | 'collectMemoryCaptures'>>,
  tasks: Pick<PersistentTaskService, 'tick'> & Partial<Pick<PersistentTaskService,'maintainNotifications'>>,
  executionReady: boolean,
) {
  const cleanup = workbench.resumeDeletions();
  workbench.reconcileBudgets?.();
  const captures = workbench.collectMemoryCaptures?.();
  const memory = captures === undefined ? {} : {memory_capture:captures};
  tasks.maintainNotifications?.();
  if (executionReady !== true) return { execution_ready: false, cleanup, ...memory };
  workbench.processMailbox();
  return { execution_ready: true, cleanup, ...memory, tasks: await tasks.tick() };
}
