import type { DatabaseSync } from 'node:sqlite';
import type { HarnessCoordinator, RunLease } from './coordinator.ts';
import type { RuntimeEventPage } from './runtime-events.ts';

interface RuntimeEventReader {
  events(runId: string, afterRevision: number, limit?: number): Promise<RuntimeEventPage>;
}

export class RuntimeEventProjector {
  private readonly db: DatabaseSync;
  private readonly coordinator: HarnessCoordinator;
  private readonly client: RuntimeEventReader;
  constructor(db: DatabaseSync, coordinator: HarnessCoordinator, client: RuntimeEventReader) {
    this.db = db; this.coordinator = coordinator; this.client = client;
  }

  async sync(lease: RunLease, runtimeRunId: string): Promise<number> {
    const binding = this.db.prepare('SELECT last_runtime_revision FROM ga_runtime_bindings WHERE run_id=?')
      .get(lease.run_id) as { last_runtime_revision: number } | undefined;
    let cursor = Number(binding?.last_runtime_revision ?? 0);
    while (true) {
      const page = await this.client.events(runtimeRunId, cursor, 100);
      for (const event of page.events) {
        this.coordinator.applyRuntimeOutcome(lease, {
          status: event.status,
          runtime_revision: event.revision,
          reason_code: typeof event.reason_code === 'string' ? event.reason_code : null,
        });
        this.coordinator.bindRuntimeRevision(lease, runtimeRunId, event.revision);
        cursor = event.revision;
      }
      if (page.events.length === 0 || cursor >= page.head_revision) return cursor;
    }
  }
}
