import type {NativeMemberExecution} from './types';

export type NativeMemberTarget=Pick<NativeMemberExecution,'root_run_id'|'child_session_ref'|'child_run_id'>;

export function parseNativeMemberExecution(value:unknown):NativeMemberExecution{
 const source=value as NativeMemberExecution;
 const id=(item:unknown)=>typeof item==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(item);
 if(!source||source.execution_authorized!==false||!id(source.root_run_id)||!id(source.child_session_ref)
  ||!id(source.child_run_id)||source.child_run_id===source.root_run_id||!id(source.child_conversation_id)||!id(source.role_ref)
  ||!Number.isSafeInteger(source.child_version)||source.child_version<1
  ||!['queued','starting','running','waiting_user','waiting_approval','cancelling','succeeded','partial','failed','cancelled','interrupted'].includes(source.child_status)
  ||typeof source.child_as_of_seq!=='string'||!/^(0|[1-9]\d{0,18})$/.test(source.child_as_of_seq)||BigInt(source.child_as_of_seq)>9223372036854775807n)throw Error('原成员执行身份尚未确认');
 return source;
}
