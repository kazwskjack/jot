import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {InteractionService} from '../interactions/service.ts';

type SlackInteractionReply={teamId:string;channelId:string;principal:string;providerThreadId:string;eventId:string;text:string};

export function createSlackInteractionReplyHandler(db:DatabaseSync,interactions:InteractionService,teamId:string){
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(teamId))throw new Error('slack_config_invalid');
  db.exec(`CREATE TABLE IF NOT EXISTS ga_slack_interaction_replies(
    team_id TEXT NOT NULL,provider_event_id TEXT NOT NULL,request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
    interaction_id TEXT NOT NULL,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,receipt_json TEXT NOT NULL,
    created_at TEXT NOT NULL,PRIMARY KEY(team_id,provider_event_id));
    CREATE TRIGGER IF NOT EXISTS ga_slack_interaction_replies_no_update BEFORE UPDATE ON ga_slack_interaction_replies
      BEGIN SELECT RAISE(ABORT,'slack_interaction_reply_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ga_slack_interaction_replies_no_delete BEFORE DELETE ON ga_slack_interaction_replies
      BEGIN SELECT RAISE(ABORT,'slack_interaction_reply_immutable'); END;`);
  return (input:SlackInteractionReply)=>{
    const command=parseCommand(input.text);
    const principal=/^slack:([A-Za-z0-9._-]{1,80}):([A-Za-z0-9._-]{1,80})$/.exec(input.principal);
    if(input.teamId!==teamId)throw new Error('slack_workspace_mismatch');
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(input.channelId)||!principal||principal[1]!==teamId
      ||input.providerThreadId.split(':')[0]!==input.channelId
      ||!/^[A-Za-z0-9._-]{1,80}:\d{10,20}\.\d{1,10}$/.test(input.providerThreadId)
      ||typeof input.eventId!=='string'||!input.eventId||input.eventId.length>512||/[\u0000-\u001f\u007f]/.test(input.eventId)
      ||typeof input.text!=='string'||input.text.length>4000)throw new Error('slack_interaction_reply_invalid');
    const requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const key='slack:'+createHash('sha256').update(JSON.stringify([input.teamId,input.eventId])).digest('hex');
    return withImmediateTransaction(db,()=>{
      const previous=db.prepare('SELECT request_sha256,interaction_id,receipt_json FROM ga_slack_interaction_replies WHERE team_id=? AND provider_event_id=?')
        .get(teamId,input.eventId) as {request_sha256?:string;interaction_id?:string;receipt_json?:string}|undefined;
      if(previous){
        if(previous.request_sha256!==requestHash||previous.interaction_id!==command.interactionId)throw new Error('slack_interaction_event_conflict');
        try{return JSON.parse(String(previous.receipt_json)) as Record<string,unknown>;}catch{throw new Error('slack_interaction_receipt_corrupt');}
      }
      const binding=db.prepare("SELECT channel_binding_id,owner_id,version FROM ga_owner_channel_bindings WHERE channel='slack' AND principal=? AND status='verified'")
        .get(input.principal) as {channel_binding_id:string;owner_id:string;version:number}|undefined;
      if(!binding||typeof binding.owner_id!=='string'||!binding.owner_id
        ||typeof binding.channel_binding_id!=='string'||!binding.channel_binding_id
        ||!Number.isSafeInteger(binding.version)||binding.version<1)throw new Error('channel_owner_binding_required');
      const thread=db.prepare(`SELECT t.conversation_id FROM ga_channel_threads t JOIN ga_conversations c
        ON c.id=t.conversation_id AND c.owner_id=? WHERE t.channel='slack' AND t.principal=? AND t.provider_thread_id=?
          AND t.channel_binding_id=? AND t.binding_version=?`)
        .get(binding.owner_id,input.principal,input.providerThreadId,binding.channel_binding_id,binding.version) as {conversation_id?:string}|undefined;
      if(!thread?.conversation_id)throw new Error('slack_interaction_not_found');
      const row=db.prepare(`SELECT i.* FROM ga_interactions i JOIN ga_runs r ON r.id=i.run_id AND r.conversation_id=i.conversation_id
        JOIN ga_conversations c ON c.id=i.conversation_id AND c.owner_id=?
        WHERE i.id=? AND i.conversation_id=? AND i.status='pending'
          AND EXISTS(SELECT 1 FROM ga_channel_message_events source WHERE source.channel='slack'
            AND source.principal=? AND source.provider_thread_id=? AND source.conversation_id=i.conversation_id
            AND source.message_id=r.input_message_id AND source.channel_binding_id=? AND source.binding_version=?)`)
        .get(binding.owner_id,command.interactionId,thread.conversation_id,input.principal,input.providerThreadId,
          binding.channel_binding_id,binding.version) as Record<string,unknown>|undefined;
      if(!row)throw new Error('slack_interaction_not_found');
      let request:Record<string,any>;
      try{request=JSON.parse(String(row.request_json)) as Record<string,any>;}catch{throw new Error('slack_interaction_request_corrupt');}
      if(request.interaction_id!==row.id||request.run_id!==row.run_id||request.status!=='pending'
        ||Number(request.version)!==Number(row.version))throw new Error('slack_interaction_request_corrupt');
      const receipt=command.kind==='decision'
        ?interactions.decide(command.interactionId,binding.owner_id,{expected_version:Number(row.version),
          action_digest:String(row.action_digest??''),decision:command.decision!},key)
        :interactions.respond(command.interactionId,binding.owner_id,{expected_version:Number(row.version),
          answers:questionAnswers(request,command.answer!)},key);
      db.prepare('INSERT INTO ga_slack_interaction_replies VALUES(?,?,?,?,?,?,?,?)')
        .run(teamId,input.eventId,requestHash,command.interactionId,binding.owner_id,thread.conversation_id,JSON.stringify(receipt),new Date().toISOString());
      return receipt;
    });
  };
}

function parseCommand(value:string):{kind:'decision';interactionId:string;decision:'approve'|'deny'}
  |{kind:'answer';interactionId:string;answer:string}{
  const match=/^\/(approve|deny|answer)\s+([A-Za-z0-9._:-]{1,128})(?:\s+([\s\S]{1,4000}))?$/.exec(value);
  if(!match)throw new Error('slack_interaction_reply_invalid');
  const action=match[1]!;const interactionId=match[2]!;const answer=match[3];
  if(action==='answer'){
    if(!answer?.trim())throw new Error('slack_interaction_reply_invalid');
    return {kind:'answer',interactionId,answer:answer.trim()};
  }
  if(answer!==undefined)throw new Error('slack_interaction_reply_invalid');
  return {kind:'decision',interactionId,decision:action==='approve'?'approve':'deny'};
}

function questionAnswers(request:Record<string,any>,value:string):Array<Record<string,unknown>>{
  if(!Array.isArray(request.questions)||request.questions.length<1)throw new Error('slack_interaction_request_corrupt');
  if(request.questions.some((question:unknown)=>!question||typeof question!=='object'||Array.isArray(question)
    ||typeof (question as Record<string,unknown>).question_id!=='string'||!Array.isArray((question as Record<string,unknown>).options)))
    throw new Error('slack_interaction_request_corrupt');
  if(request.questions.length!==1){
    let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new Error('slack_interaction_question_unsupported');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).sort().join(',')!=='answers'
      ||!Array.isArray((parsed as Record<string,unknown>).answers))throw new Error('slack_interaction_question_unsupported');
    const questions=new Map(request.questions.map((question:Record<string,unknown>)=>[question.question_id,question]));
      if(questions.size!==request.questions.length)throw new Error('slack_interaction_request_corrupt');
    const seen=new Set<string>();
    const answers=((parsed as {answers:unknown[]}).answers).map(raw=>{
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('interaction_answer_invalid');
      const answer=raw as Record<string,unknown>;
      if(Object.keys(answer).some(key=>!['question_id','selected_option_ids','custom_text'].includes(key))
        ||typeof answer.question_id!=='string'||!questions.has(answer.question_id)||seen.has(answer.question_id))throw new Error('interaction_answer_invalid');
      seen.add(answer.question_id);
      const question=questions.get(answer.question_id) as Record<string,unknown>;
      if(answer.selected_option_ids!==undefined&&(!Array.isArray(answer.selected_option_ids)
        ||answer.selected_option_ids.length>50||answer.selected_option_ids.some(id=>typeof id!=='string')))
        throw new Error('interaction_answer_invalid');
      if(answer.custom_text!==undefined&&(typeof answer.custom_text!=='string'||!answer.custom_text.trim()
        ||answer.custom_text.length>4000||question.allow_custom!==true))throw new Error('interaction_answer_invalid');
      if(!((Array.isArray(answer.selected_option_ids)&&answer.selected_option_ids.length)
        ||(typeof answer.custom_text==='string'&&answer.custom_text.trim())))throw new Error('interaction_answer_invalid');
      return {question_id:answer.question_id,
        ...(answer.selected_option_ids!==undefined?{selected_option_ids:answer.selected_option_ids}:{}),
        ...(answer.custom_text!==undefined?{custom_text:answer.custom_text}:{})};
    });
    if(seen.size!==questions.size)throw new Error('interaction_answer_invalid');
    return answers;
  }
  const question=request.questions[0];
  if(!question||typeof question.question_id!=='string'||!Array.isArray(question.options))throw new Error('slack_interaction_request_corrupt');
  const selected=question.options.find((option:Record<string,unknown>)=>option.option_id===value||option.label===value);
  if(selected)return [{question_id:question.question_id,selected_option_ids:[selected.option_id]}];
  if(question.allow_custom!==true)throw new Error('interaction_answer_invalid');
  return [{question_id:question.question_id,selected_option_ids:[],custom_text:value}];
}
