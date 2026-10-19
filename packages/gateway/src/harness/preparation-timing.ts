import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

type Phase='session_confirm'|'opening_snapshot'|'attachments'|'prompt_submit'|'input_recovery'|'goal_resume'|'preparation_total';
type Outcome='succeeded'|'failed'|'cancelled';
type Metadata={snapshot_records?:number;snapshot_has_more?:boolean;attachment_count?:number};
export type PreparationTimingRecord={event:'jot_preparation_timing';run_hash:string;mode:'chat'|'work'|'unknown';phase:Phase;started_at:string;offset_ms:number;duration_ms:number;outcome:Outcome}&Metadata;
export type PreparationTimingReporter=(record:PreparationTimingRecord)=>void;
const round=(value:number)=>Math.round(Math.max(0,value)*1000)/1000;

/** Diagnostic metadata only. Neither input contents nor dependency errors enter logs. */
export class PreparationTiming{
 private readonly started=performance.now();
 private readonly wall=Date.now();
 private readonly hash:string;
 private readonly mode:'chat'|'work'|undefined;
 private readonly signal:AbortSignal;
 private readonly report:PreparationTimingReporter;
 private completed=false;
 constructor(runId:string,mode:'chat'|'work'|undefined,signal:AbortSignal,report:PreparationTimingReporter=record=>{process.stderr.write(JSON.stringify(record)+'\n');}){this.hash=createHash('sha256').update(runId).digest('hex');this.mode=mode;this.signal=signal;this.report=report;}
 private emit(phase:Phase,start:number,outcome:Outcome,metadata:Metadata={}){
  const safe:Metadata={};
  for(const key of ['snapshot_records','attachment_count'] as const){const value=metadata[key];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=100000)safe[key]=value;}
  if(typeof metadata.snapshot_has_more==='boolean')safe.snapshot_has_more=metadata.snapshot_has_more;
  const offset=round(start-this.started);
  const record:PreparationTimingRecord={event:'jot_preparation_timing',run_hash:this.hash,mode:this.mode==='chat'?'chat':this.mode==='work'?'work':'unknown',phase,started_at:new Date(this.wall+offset).toISOString(),offset_ms:offset,duration_ms:round(performance.now()-start),outcome,...safe};
  // Observability must not alter task acceptance, execution or cancellation.
  try{this.report(record);}catch{}
 }
 async measure<T>(phase:Exclude<Phase,'preparation_total'>,operation:()=>Promise<T>,metadata?:(value:T)=>Metadata):Promise<T>{
  const start=performance.now();
  try{const value=await operation();let facts:Metadata={};try{facts=metadata?.(value)??{};}catch{}this.emit(phase,start,'succeeded',facts);return value;}
  catch(error){this.emit(phase,start,this.signal.aborted?'cancelled':'failed');throw error;}
 }
 finish(outcome:Outcome){if(this.completed)return;this.completed=true;this.emit('preparation_total',this.started,outcome);}
}
