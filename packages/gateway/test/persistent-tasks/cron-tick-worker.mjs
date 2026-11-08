import { openProductDatabase } from '../../src/db/database.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';

const [databasePath, initialTime, encodedAgent, encodedControl='{}'] = process.argv.slice(2);
const agent = JSON.parse(encodedAgent);
const control = JSON.parse(encodedControl);
const db = openProductDatabase(databasePath);
let currentTime = initialTime;
let interceptCommit = false;
const workbench = {
  getAgent(owner, agentId) {
    if (owner !== 'alice' || agentId !== agent.agent_id) throw new Error('agent_not_found');
    return agent;
  },
  bindRun() {}
};

let service;
try {
  let serviceDb = db;
  if(control.mode==='before_commit'||control.mode==='after_commit') {
    serviceDb = new Proxy(db, { get(target,property) {
      if(property==='exec') return sql => {
        const ready=interceptCommit&&sql==='COMMIT'&&(control.expectedStatus
          ?target.prepare('SELECT 1 FROM wb_persistent_tasks WHERE task_id=? AND status=?').get(control.taskId,control.expectedStatus)
          :control.expectedNextDue?target.prepare('SELECT 1 FROM wb_persistent_tasks WHERE task_id=? AND next_due_at=?').get(control.taskId,control.expectedNextDue)
          :target.prepare('SELECT 1 FROM wb_task_occurrences WHERE task_id=? AND trigger_key=?').get(control.taskId,control.triggerKey));
        if(interceptCommit && sql==='COMMIT' && ready) {
          if(control.mode==='before_commit') process.exit(71);
          target.exec(sql);
          process.exit(72);
        }
        return target.exec(sql);
      };
      const value = Reflect.get(target,property,target);
      return typeof value==='function' ? value.bind(target) : value;
    }});
  }
  service = new PersistentTaskService(serviceDb, workbench, { now: () => new Date(currentTime) });
  process.send({ type: 'ready' });
} catch (error) {
  process.send({ type: 'worker-error', error: String(error?.message ?? error) }, () => {
    db.close();
    process.disconnect();
  });
}

async function tick() {
  interceptCommit = control.mode==='before_commit'||control.mode==='after_commit';
  try {
    if(control.action){service[control.action]('alice',control.taskId,control.version);return;}
    process.send({ type: 'tick-done', ...(await service.tick()) });
  } catch (error) {
    process.send({ type: 'worker-error', error: String(error?.stack ?? error?.message ?? error) });
  }
}

process.on('message', async message => {
  try {
    if (message?.type === 'set-time') {
      currentTime = message.now;
      process.send({ type: 'time-set' });
    } else if (message?.type === 'tick') {
      process.send({ type: 'tick-started' }, error => {
        if(error)process.send({type:'worker-error',error:String(error)});
        else void tick();
      });
    } else if (message?.type === 'close') {
      process.send({ type: 'closed' }, () => {
        db.close();
        process.disconnect();
      });
    }
  } catch (error) {
    process.send({ type: 'worker-error', error: String(error?.stack ?? error?.message ?? error) });
  }
});
