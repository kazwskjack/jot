import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import type {ContractValidator} from '../contracts/validator.ts';
import type {ArtifactService} from './service.ts';

type Row=Record<string,unknown>;
const exact=(value:unknown,keys:string[]):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

function install(db:DatabaseSync){
 db.exec('SAVEPOINT artifact_command_recovery_install');
 try{
  db.exec(`CREATE TABLE IF NOT EXISTS ga_artifact_command_closures(
   owner_id TEXT NOT NULL,operation TEXT NOT NULL,idempotency_key TEXT NOT NULL,artifact_id TEXT NOT NULL,
   request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,receipt_protocol TEXT NOT NULL
    CHECK(receipt_protocol IN('artifact-archive-atomic-v1','artifact-restore-atomic-v2')),
   created_at TEXT NOT NULL,PRIMARY KEY(owner_id,operation,idempotency_key));
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_closures_no_update BEFORE UPDATE ON ga_artifact_command_closures
    BEGIN SELECT RAISE(ABORT,'artifact_command_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_closures_no_delete BEFORE DELETE ON ga_artifact_command_closures
    BEGIN SELECT RAISE(ABORT,'artifact_command_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_closures_no_replace BEFORE INSERT ON ga_artifact_command_closures
    WHEN EXISTS(SELECT 1 FROM ga_artifact_command_closures c WHERE c.owner_id=NEW.owner_id AND c.operation=NEW.operation AND c.idempotency_key=NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT,'artifact_command_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_registered_before_close BEFORE INSERT ON ga_artifact_command_closures
    WHEN EXISTS(SELECT 1 FROM ga_idempotency i WHERE i.owner_id=NEW.owner_id AND i.operation=NEW.operation AND i.idempotency_key=NEW.idempotency_key
     AND(i.response_status IS NOT NULL OR i.receipt_protocol IS NOT NEW.receipt_protocol OR i.request_sha256 IS NOT NEW.request_sha256))
    BEGIN SELECT RAISE(ABORT,'artifact_command_unresolved'); END;
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_closed_before_reservation BEFORE INSERT ON ga_idempotency
    WHEN EXISTS(SELECT 1 FROM ga_artifact_command_closures c WHERE c.owner_id=NEW.owner_id AND c.operation=NEW.operation AND c.idempotency_key=NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT,'artifact_command_closed'); END;
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_closed_before_commit BEFORE UPDATE ON ga_idempotency
    WHEN EXISTS(SELECT 1 FROM ga_artifact_command_closures c WHERE c.owner_id=OLD.owner_id AND c.operation=OLD.operation AND c.idempotency_key=OLD.idempotency_key)
    BEGIN SELECT RAISE(ABORT,'artifact_command_closed'); END;
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_receipt_no_delete BEFORE DELETE ON ga_idempotency
    WHEN OLD.operation LIKE 'POST /v1/artifacts/%/archive' OR OLD.operation LIKE 'POST /v1/artifacts/%/restore'
    BEGIN SELECT RAISE(ABORT,'artifact_command_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_receipt_no_replace BEFORE INSERT ON ga_idempotency
    WHEN (NEW.operation LIKE 'POST /v1/artifacts/%/archive' OR NEW.operation LIKE 'POST /v1/artifacts/%/restore')
     AND EXISTS(SELECT 1 FROM ga_idempotency i WHERE i.owner_id=NEW.owner_id AND i.operation=NEW.operation AND i.idempotency_key=NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT,'artifact_command_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS ga_artifact_command_receipt_identity BEFORE UPDATE ON ga_idempotency
    WHEN (OLD.operation LIKE 'POST /v1/artifacts/%/archive' OR OLD.operation LIKE 'POST /v1/artifacts/%/restore')
     AND(NEW.owner_id IS NOT OLD.owner_id OR NEW.operation IS NOT OLD.operation OR NEW.idempotency_key IS NOT OLD.idempotency_key
      OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.receipt_protocol IS NOT OLD.receipt_protocol
      OR OLD.response_status IS NOT NULL AND(NEW.response_status IS NOT OLD.response_status OR NEW.response_json IS NOT OLD.response_json))
    BEGIN SELECT RAISE(ABORT,'artifact_command_immutable'); END;`);
  db.exec('RELEASE artifact_command_recovery_install');
 }catch(error){db.exec('ROLLBACK TO artifact_command_recovery_install; RELEASE artifact_command_recovery_install');throw error;}
}

/** Original HTTP receipt disposition only. No archive/restore job is dispatched. */
export class ArtifactCommandRecovery{
 private readonly db:DatabaseSync;
 private readonly artifacts:ArtifactService;
 private readonly contracts:ContractValidator;
 constructor(db:DatabaseSync,artifacts:ArtifactService,contracts:ContractValidator){this.db=db;this.artifacts=artifacts;this.contracts=contracts;install(db);}
 assertOpen(owner:string,operation:string,key:string){
  if(this.db.prepare('SELECT 1 FROM ga_artifact_command_closures WHERE owner_id=? AND operation=? AND idempotency_key=?').get(owner,operation,key))throw Error('artifact_command_closed');
 }
 disposition(owner:string,id:string,key:string,input:unknown,close=false){
  if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(id)
   ||typeof key!=='string'||!/^[!-~]{8,128}$/.test(key)||!exact(input,['path','body'])
   ||typeof input.path!=='string'||input.path.length>1024||!input.body||typeof input.body!=='object'||Array.isArray(input.body))throw Error('artifact_command_request_invalid');
  const match=/^\/artifacts\/([^/]+)\/(archive|restore)$/.exec(input.path);
  let target;try{target=match&&decodeURIComponent(match[1]);}catch{throw Error('artifact_command_request_invalid');}
  if(!match||target!==id)throw Error('artifact_command_request_invalid');
  const kind=match[2],operation=`POST /v1${input.path}`;
  const requestSchema=kind==='archive'?'ArtifactArchiveRequest':'ArtifactRestoreRequest';
  const receiptSchema=kind==='archive'?'ArtifactArchiveReceipt':'ArtifactRestoreReceipt';
  if(!this.contracts.validateComponent(requestSchema,input.body).valid)throw Error('artifact_command_request_invalid');
  const protocol=kind==='archive'?'artifact-archive-atomic-v1':'artifact-restore-atomic-v2';
  const body=input.body as Row,requestJson=canonicalJson(body),requestSha=hash(body);
  const common={protocol:1,artifact_id:id,kind,command_key:key,request_sha256:requestSha,
   command_sha256:hash({artifact_id:id,command_key:key,command_path:input.path,...body}),execution_authorized:false,restore_authorized:false};
  const read=()=>{
   this.artifacts.get(id,owner);
   const closed=this.db.prepare('SELECT artifact_id,request_json,request_sha256,receipt_protocol FROM ga_artifact_command_closures WHERE owner_id=? AND operation=? AND idempotency_key=?').get(owner,operation,key) as Row|undefined;
   const receipt=this.db.prepare('SELECT request_sha256,response_status,response_json,receipt_protocol FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get(owner,operation,key) as Row|undefined;
   if(receipt&&receipt.request_sha256!==requestSha||closed&&closed.request_sha256!==requestSha)throw Error('idempotency_conflict');
   if(closed){
    if(closed.artifact_id!==id||closed.request_json!==requestJson||closed.receipt_protocol!==protocol
     ||receipt&&(receipt.response_status!==null||receipt.receipt_protocol!==protocol))throw Error('artifact_command_unresolved');
    return {...common,state:'terminal_rejected',no_effect:true,reason:'artifact_command_closed'};
   }
   if(receipt?.response_status!==null&&receipt?.response_status!==undefined){
    let result:unknown;try{result=JSON.parse(String(receipt.response_json));}catch{return {...common,state:'unresolved',reason:'unsupported_receipt'};}
    if(receipt.response_status!==202||receipt.receipt_protocol!==null&&receipt.receipt_protocol!==protocol
     ||!this.contracts.validateComponent(receiptSchema,result).valid||!result||typeof result!=='object'||Array.isArray(result))return {...common,state:'unresolved',reason:'unsupported_receipt'};
    const saved=result as Row,selected=Object.hasOwn(body,'restore_version')||Object.hasOwn(body,'restore_sha256')||Object.hasOwn(body,'part_index');
    if(saved.accepted!==true||saved.artifact_id!==id||body.expected_version!==undefined&&saved.version!==body.expected_version
     ||kind==='archive'&&(saved.archive_protocol!==1||saved.sha256!==body.expected_sha256)
     ||kind==='restore'&&body.expected_version!==undefined&&saved.restore_protocol!==(selected?3:2)
     ||selected&&(saved.requested_version!==body.restore_version||saved.requested_sha256!==body.restore_sha256||saved.part_index!==body.part_index))return {...common,state:'unresolved',reason:'unsupported_receipt'};
    return {...common,state:'settled',result};
   }
   if(receipt&&receipt.receipt_protocol!==protocol)return {...common,state:'unresolved',reason:'legacy_pending'};
   if(close){
    this.db.prepare('INSERT INTO ga_artifact_command_closures VALUES(?,?,?,?,?,?,?,?)').run(owner,operation,key,id,requestJson,requestSha,protocol,new Date().toISOString());
    return {...common,state:'terminal_rejected',no_effect:true,reason:'artifact_command_closed'};
   }
   return {...common,state:receipt?'recorded_pending':'unobserved'};
  };
  return close?withImmediateTransaction(this.db,read):withReadTransaction(this.db,read);
 }
}
