import type { WorkbenchService } from '../workbench/service.ts';
import type { PersistentTaskService } from './service.ts';

/** Cleanup never depends on host readiness. Autonomous admission does. */
export async function maintainWorkbench(
  workbench: Pick<WorkbenchService, 'resumeDeletions' | 'processMailbox'> & Partial<Pick<WorkbenchService,'reconcileBudgets' | 'collectMemoryCaptures'>>,
  tasks: Pick<PersistentTaskService, 'tick'> & Partial<Pick<PersistentTaskService,'maintainNotifications'|'collectDiscoverySources'>>,
  executionReady: boolean,
) {
  const cleanup = workbench.resumeDeletions();
  workbench.reconcileBudgets?.();
  const captures = workbench.collectMemoryCaptures?.();
  const memory = captures === undefined ? {} : {memory_capture:captures};
  tasks.maintainNotifications?.();
  if (executionReady !== true) return { execution_ready: false, cleanup, ...memory };
  const sources=tasks.collectDiscoverySources?.();
  workbench.processMailbox();
  return { execution_ready: true, cleanup, ...memory,...(sources===undefined?{}:{discovery_sources:sources}), tasks: await tasks.tick() };
}
