import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {inspectOrdinarySteeringBinding} from '../conversations/ordinary-steering-binding.ts';

/** A replay prohibition, never proof of native acceptance or permission to run. */
export function installOrdinarySteeringCustody(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS ga_ordinary_steering_custody (
  command_id TEXT PRIMARY KEY REFERENCES ga_run_commands(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, session_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
  input_message_id TEXT NOT NULL, command_sha256 TEXT NOT NULL, input_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(conversation_id,client_message_id)
 );
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_custody_update BEFORE UPDATE ON ga_ordinary_steering_custody
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_custody_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_custody_replace BEFORE INSERT ON ga_ordinary_steering_custody
 WHEN EXISTS(SELECT 1 FROM ga_ordinary_steering_custody WHERE command_id=NEW.command_id OR (conversation_id=NEW.conversation_id AND client_message_id=NEW.client_message_id))
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_custody_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_custody_delete BEFORE DELETE ON ga_ordinary_steering_custody
 WHEN EXISTS(SELECT 1 FROM ga_runs WHERE id=OLD.run_id) AND EXISTS(SELECT 1 FROM ga_run_commands WHERE id=OLD.command_id)
  AND EXISTS(SELECT 1 FROM ga_conversations WHERE id=OLD.conversation_id)
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_custody_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_command_identity BEFORE UPDATE ON ga_run_commands
 WHEN EXISTS(SELECT 1 FROM ga_ordinary_steering_custody WHERE command_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.kind IS NOT OLD.kind
   OR NEW.payload_json IS NOT OLD.payload_json OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at)
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_custody_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_command_replace BEFORE INSERT ON ga_run_commands
 WHEN EXISTS(SELECT 1 FROM ga_ordinary_steering_custody WHERE command_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_custody_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_command_delete BEFORE DELETE ON ga_run_commands
 WHEN EXISTS(SELECT 1 FROM ga_ordinary_steering_custody WHERE command_id=OLD.id)
  AND EXISTS(SELECT 1 FROM ga_runs WHERE id=OLD.run_id)
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_custody_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_no_fallback BEFORE INSERT ON ga_messages
 WHEN NEW.role='user' AND EXISTS(SELECT 1 FROM ga_ordinary_steering_custody f
  WHERE f.conversation_id=NEW.conversation_id AND f.client_message_id=NEW.client_message_id
   AND (NEW.id IS NOT f.input_message_id OR NEW.run_id IS NOT f.run_id))
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_fallback_forbidden'); END;
 `);}

export function hasOrdinarySteeringCustody(db:DatabaseSync,commandId:string):boolean{
 return !!db.prepare('SELECT 1 FROM ga_ordinary_steering_custody WHERE command_id=?').get(commandId);
}

export function reserveOrdinarySteeringCustody(db:DatabaseSync,runId:string,sessionId:string,commandId:string,lease:unknown){
 return withImmediateTransaction(db,()=>{
  const proof=inspectOrdinarySteeringBinding(db,runId,sessionId,commandId,lease);
  const command=db.prepare('SELECT payload_json FROM ga_run_commands WHERE id=?').get(commandId)!;
  const clientId=JSON.parse(String(command.payload_json)).client_message_id as string;
  const expected={command_id:commandId,run_id:runId,conversation_id:proof.conversation_id,
   owner_id:proof.owner_id,session_id:sessionId,client_message_id:clientId,input_message_id:proof.input_message_id,
   command_sha256:proof.command_sha256,input_sha256:proof.input_sha256};
  const existing=db.prepare('SELECT * FROM ga_ordinary_steering_custody WHERE command_id=?').get(commandId);
  if(existing){
   if(Object.entries(expected).some(([key,value])=>existing[key]!==value))throw Error('ordinary_steering_custody_mismatch');
  }else{
   db.prepare(`INSERT INTO ga_ordinary_steering_custody(command_id,run_id,conversation_id,owner_id,session_id,client_message_id,input_message_id,command_sha256,input_sha256,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(expected),new Date().toISOString());
  }
  return proof;
 });
}
