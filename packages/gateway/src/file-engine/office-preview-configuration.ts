import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {OfficePreviewConfiguration,OfficePreviewConfigurationUpdate} from '../../contracts/types.ts';

export function officePreviewEnvironmentSettings(){
 const service=process.env.GENERAL_AGENT_OFFICE_PREVIEW_SERVICE?.trim()||'builtin';
 const binaryPath=process.env.GENERAL_AGENT_LIBREOFFICE?.trim()||'';
 if(!['builtin','libreoffice'].includes(service)||binaryPath.length>4096||/[\u0000-\u001f\u007f]/.test(binaryPath))throw Error('office_preview_configuration_invalid');
 return {service:service as OfficePreviewConfiguration['service'],binaryPath};
}
export class OfficePreviewConfigurationStore{
 constructor(private readonly db:DatabaseSync,private readonly ownerId:string|undefined){}
 get(owner?:string):OfficePreviewConfiguration{
  const row=this.db.prepare('SELECT version,service,binary_path FROM wb_office_preview_configuration WHERE singleton=1').get() as {version:number;service:OfficePreviewConfiguration['service'];binary_path:string}|undefined;
  const settings=row?{version:row.version,service:row.service,binaryPath:row.binary_path}:{version:0,...officePreviewEnvironmentSettings()};
  return {protocol:1,...settings,writable:this.ownerId!==undefined&&owner===this.ownerId,execution_authorized:false};
 }
 update(owner:string,key:string,input:unknown):OfficePreviewConfiguration{
  if(!this.ownerId||owner!==this.ownerId)throw Error('office_preview_configuration_forbidden');
  if(!/^[\x21-\x7E]{8,128}$/.test(key))throw Error('idempotency_key_invalid');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='binaryPath,expected_version,service')throw Error('office_preview_configuration_invalid');
  const value=input as OfficePreviewConfigurationUpdate;
  if(!Number.isSafeInteger(value.expected_version)||value.expected_version<0||value.expected_version>=Number.MAX_SAFE_INTEGER
   ||!['builtin','libreoffice'].includes(value.service)||typeof value.binaryPath!=='string'||value.binaryPath.length>4096||/[\u0000-\u001f\u007f]/.test(value.binaryPath))throw Error('office_preview_configuration_invalid');
  const binaryPath=value.binaryPath.trim();
  const sha=createHash('sha256').update(JSON.stringify([value.expected_version,value.service,binaryPath])).digest('hex');
  return withImmediateTransaction(this.db,()=>{
   const prior=this.db.prepare('SELECT request_sha256,response_json FROM wb_office_preview_configuration_commands WHERE owner_id=? AND command_key=?').get(owner,key) as {request_sha256:string;response_json:string}|undefined;
   if(prior){if(prior.request_sha256!==sha)throw Error('idempotency_conflict');return JSON.parse(prior.response_json) as OfficePreviewConfiguration;}
   const current=this.get(owner);if(current.version!==value.expected_version)throw Error('office_preview_configuration_conflict');
   const result:OfficePreviewConfiguration={protocol:1,version:current.version+1,service:value.service,binaryPath,writable:true,execution_authorized:false};
   this.db.prepare(`INSERT INTO wb_office_preview_configuration(singleton,version,service,binary_path) VALUES(1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,service=excluded.service,binary_path=excluded.binary_path`).run(result.version,result.service,result.binaryPath);
   this.db.prepare('INSERT INTO wb_office_preview_configuration_commands(owner_id,command_key,request_sha256,response_json,created_at) VALUES(?,?,?,?,?)').run(owner,key,sha,JSON.stringify(result),new Date().toISOString());
   return result;
  });
 }
}
