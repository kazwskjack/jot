import assert from 'node:assert/strict';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { InteractionService } from '../../src/interactions/service.ts';
import { createSlackInteractionReplyHandler } from '../../src/channels/slack-interactions.ts';

function fixture(kind = 'approval') {
  const db = openProductDatabase(':memory:');
  const now = new Date().toISOString();
  const bindings = new OwnerChannelBindings(db, { enabled: ['slack'] });
  installChannelAuthorityMigration(db);
  const challenge = bindings.create('owner-1', 'slack');
  bindings.acceptProof('slack', 'slack:T111:U111', challenge.code);
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv-1', 'owner-1', 'ws-1', 'Slack thread', '{}', 1, now, now);
  db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('input-1', 'conv-1', null, 'user', 'complete', '{"blocks":[]}', now, now);
  db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('run-1', 'conv-1', 'input-1', 'waiting_approval', 4, now, now);
  db.prepare(`INSERT INTO ga_channel_threads(channel,principal,provider_thread_id,conversation_id,created_at,updated_at,channel_binding_id,binding_version)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run('slack', 'slack:T111:U111', 'C111:1761000000.000001', 'conv-1', now, now, challenge.channel_binding_id, 1);
  db.prepare(`INSERT INTO ga_channel_message_events(channel,principal,provider_thread_id,provider_message_id,conversation_id,message_id,run_id,attachments_json,event_sha256,created_at,channel_binding_id,binding_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('slack','slack:T111:U111','C111:1761000000.000001','Ev-source','conv-1','input-1','run-1','[]','b'.repeat(64),now,challenge.channel_binding_id,1);
  const request = kind === 'approval'
    ? { interaction_id: 'int-approval-1', run_id: 'run-1', version: 1, status: 'pending', kind,
      action_digest: 'sha256:' + 'a'.repeat(64), action_summary: 'approve this action' }
    : { interaction_id: 'int-question-1', run_id: 'run-1', version: 1, status: 'pending', kind,
      questions: [{ question_id: 'question-1', prompt: 'Continue?', options: [
        { option_id: 'continue', label: 'Continue' }, { option_id: 'stop', label: 'Stop' },
      ], multiple: false, allow_custom: true }] };
  const id = request.interaction_id;
  db.prepare('INSERT INTO ga_interactions(id,conversation_id,run_id,kind,status,version,action_digest,request_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'conv-1', 'run-1', kind, 'pending', 1, request.action_digest ?? null, JSON.stringify(request),
      new Date(Date.now() + 60_000).toISOString(), now);
  const interactions = new InteractionService(db, new EventStore(db));
  const handle = createSlackInteractionReplyHandler(db, interactions, 'T111');
  return { db, handle, id };
}

const base = { teamId: 'T111', channelId: 'C111', principal: 'slack:T111:U111',
  providerThreadId: 'C111:1761000000.000001' };

test('signed Slack approval replies resolve only the interaction in the mapped owner thread and dedupe provider retries', () => {
  const f = fixture();
  try {
    const input = { ...base, eventId: 'Ev-approve-1', text: '/approve int-approval-1' };
    const receipt = f.handle(input);
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.run_id, 'run-1');
    assert.equal(receipt.status, 'answered');
    assert.deepEqual(f.handle(input), receipt);
    assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n), 1);
    assert.equal(f.db.prepare('SELECT status FROM ga_interactions WHERE id=?').get(f.id).status, 'answered');
    assert.throws(() => f.handle({ ...input, text: '/deny int-approval-1' }), /slack_interaction_event_conflict/);
    assert.throws(() => f.handle({ ...input, teamId: 'T222', eventId: 'Ev-wrong-team' }), /slack_workspace_mismatch/);
    assert.throws(() => f.handle({ ...input, principal: 'slack:T111:U222', eventId: 'Ev-unbound-user' }), /channel_owner_binding_required/);
    assert.throws(() => f.handle({ ...base, channelId: 'C222', providerThreadId: 'C222:1761000000.000001',
      eventId: 'Ev-wrong-channel', text: '/approve int-approval-1' }), /slack_interaction_not_found/);
  } finally { f.db.close(); }
});

test('Slack interaction replies require the source message that started the original run', () => {
  const f = fixture();
  try {
    const now=new Date().toISOString();
    f.db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('input-other','conv-1',null,'user','complete','{"blocks":[]}',now,now);
    f.db.prepare("UPDATE ga_channel_message_events SET message_id='input-other' WHERE provider_message_id='Ev-source'").run();
    assert.throws(() => f.handle({ ...base, eventId: 'Ev-source-mismatch', text: '/approve int-approval-1' }),
      /slack_interaction_not_found/);
  } finally { f.db.close(); }
});

test('signed Slack elicitation replies map a choice to the original question and run', () => {
  const f = fixture('question');
  try {
    const receipt = f.handle({ ...base, eventId: 'Ev-answer-1', text: '/answer int-question-1 Continue' });
    assert.equal(receipt.status, 'answered');
    const saved = JSON.parse(f.db.prepare('SELECT response_json FROM ga_interactions WHERE id=?').get(f.id).response_json);
    assert.deepEqual(saved.answers, [{ question_id: 'question-1', selected_option_ids: ['continue'] }]);
    assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 1);
  } finally { f.db.close(); }
});

test('explicit Slack elicitation replies support validated multi-question JSON answers', () => {
  const f = fixture('question');
  try {
    const row=f.db.prepare('SELECT request_json FROM ga_interactions WHERE id=?').get(f.id);
    const request=JSON.parse(row.request_json);
    request.questions.push({question_id:'question-2',prompt:'Details?',options:[],multiple:false,allow_custom:true});
    f.db.prepare('UPDATE ga_interactions SET request_json=? WHERE id=?').run(JSON.stringify(request),f.id);
    const incomplete={answers:[{question_id:'question-1',selected_option_ids:['continue']}]};
    assert.throws(()=>f.handle({...base,eventId:'Ev-answer-incomplete',text:`/answer ${f.id} ${JSON.stringify(incomplete)}`}),
      /interaction_answer_invalid/);
    const answer={answers:[{question_id:'question-1',selected_option_ids:['continue']},
      {question_id:'question-2',selected_option_ids:[],custom_text:'Additional detail'}]};
    const receipt=f.handle({...base,eventId:'Ev-answer-multi',text:`/answer ${f.id} ${JSON.stringify(answer)}`});
    assert.equal(receipt.status,'answered');
    const saved=JSON.parse(f.db.prepare('SELECT response_json FROM ga_interactions WHERE id=?').get(f.id).response_json);
    assert.deepEqual(saved.answers,answer.answers);
  } finally { f.db.close(); }
});

test('Slack multi-question replies reject duplicate persisted question ids', () => {
  const f = fixture('question');
  try {
    const row=f.db.prepare('SELECT request_json FROM ga_interactions WHERE id=?').get(f.id);
    const request=JSON.parse(row.request_json);
    request.questions.push({ ...request.questions[0], prompt: 'Duplicate question id' });
    f.db.prepare('UPDATE ga_interactions SET request_json=? WHERE id=?').run(JSON.stringify(request),f.id);
    const answer={answers:[{question_id:'question-1',selected_option_ids:[],custom_text:'one answer'}]};
    assert.throws(()=>f.handle({...base,eventId:'Ev-answer-duplicate-question',
      text:`/answer ${f.id} ${JSON.stringify(answer)}`}),/slack_interaction_request_corrupt/);
  } finally { f.db.close(); }
});
