import type {DatabaseSync} from 'node:sqlite';
import type {NativeArtifactReceipt} from './native-tool-result.js';

/** A result reference grants neither artifact publication nor execution authority. */
export function bindToolArtifactReceipts(db:DatabaseSync,conversationId:string,runId:string,
 payload:Record<string,unknown>,receipts?:NativeArtifactReceipt[]):Record<string,unknown>{
 if(!receipts?.length||payload.run_id!==runId||!payload.detail||typeof payload.detail!=='object'||Array.isArray(payload.detail))return payload;
 const read=db.prepare(`SELECT v.sha256,v.metadata_json FROM ga_artifacts a
  JOIN ga_artifact_versions v ON v.artifact_id=a.id
  JOIN ga_conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id
  JOIN ga_runs r ON r.conversation_id=c.id
  WHERE a.id=? AND v.version=? AND a.conversation_id=? AND r.id=?`);
 const artifacts:NativeArtifactReceipt[]=[];
 for(const receipt of receipts){
  const row=read.get(receipt.artifact_id,receipt.version,conversationId,runId) as {sha256:string;metadata_json:string}|undefined;
  if(!row||row.sha256!==receipt.sha256)continue;
  let metadata:Record<string,unknown>;
  try{metadata=JSON.parse(row.metadata_json) as Record<string,unknown>;}catch{continue;}
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||!['ready','delivered'].includes(String(metadata.status)))continue;
  artifacts.push({artifact_id:receipt.artifact_id,version:receipt.version,sha256:receipt.sha256});
 }
 return artifacts.length?{...payload,detail:{...payload.detail,result_artifacts:artifacts}}:payload;
}
