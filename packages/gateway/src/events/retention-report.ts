import { DatabaseSync } from 'node:sqlite';
import { buildEventRetentionPlan } from './retention-plan.ts';

// Standalone, read-only inventory. Intentionally has no execute/cleanup mode and
// does not call openProductDatabase (which runs schema migrations on startup).
const args = process.argv.slice(2);
if (!args[0] || args.length > 4 || args.some(value => value.startsWith('--'))) {
  console.error('usage: retention-report DATABASE [NOW_ISO] [AFTER_CONVERSATION_ID] [LIMIT]');
  process.exitCode = 2;
} else {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(args[0], { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=75;');
    const report = buildEventRetentionPlan(db, {
      ...(args[1] ? { now: args[1] } : {}),
      ...(args[2] ? { afterConversationId: args[2] } : {}),
      ...(args[3] ? { limit: Number(args[3]) } : {}),
    });
    console.log(JSON.stringify(report));
  } catch {
    // No SQL/payload/paths in scheduled logs; failures never imply an empty plan.
    console.error('event_retention_inventory_failed');
    process.exitCode = 1;
  } finally { db?.close(); }
}
