import {resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';

export type ArchiveReference={server_path:string;display_name:string;size_bytes:number;sha256:string};
export type ArchiveManifestFile={remote_name:string;local_path:string;size:number;md5:string;sha256:string};

export function artifactArchiveReferences(db:DatabaseSync,artifactId:string,scope:'all'|'current'='all'):ArchiveReference[]{
 const parts=db.prepare(`SELECT server_path,display_name,size_bytes,sha256 FROM ga_artifact_parts
  WHERE artifact_id=? ORDER BY part_index`).all(artifactId) as Array<Record<string,unknown>>;
 const versions=db.prepare(`SELECT v.server_path,json_extract(v.metadata_json,'$.file_name') display_name,v.size_bytes,v.sha256
  FROM ga_artifact_versions v JOIN ga_artifacts a ON a.id=v.artifact_id WHERE v.artifact_id=?
  AND v.version<=a.current_version AND (?='all' OR v.version=a.current_version)
  AND NOT (a.kind='generated_document_group' AND v.version=1
    AND EXISTS(SELECT 1 FROM ga_artifact_parts p WHERE p.artifact_id=a.id))
  ORDER BY v.version`).all(artifactId,scope) as Array<Record<string,unknown>>;
 const files=new Map<string,ArchiveReference>();
 for(const row of [...parts,...versions]){
  if(typeof row.server_path!=='string'||!row.server_path)throw Error('archive_reference_invalid');
  const path=resolve(row.server_path),size=Number(row.size_bytes),sha=String(row.sha256);
  if(!Number.isSafeInteger(size)||size<0||!/^[a-f0-9]{64}$/.test(sha))throw Error('archive_reference_invalid');
  const existing=files.get(path);
  if(existing){
   if(existing.size_bytes!==size||existing.sha256!==sha)throw Error('archive_reference_conflict');
   continue;
  }
  files.set(path,{server_path:path,display_name:String(row.display_name||'file'),size_bytes:size,sha256:sha});
 }
 return [...files.values()];
}

export function artifactArchiveManifest(references:ArchiveReference[],encoded:string,required:ArchiveReference[]=references):ArchiveManifestFile[]|null{
 let manifest:unknown;
 try{manifest=JSON.parse(encoded);}catch{return null;}
 if(!references.length||!Array.isArray(manifest)||!manifest.length||manifest.length>references.length)return null;
 const expected=new Map(references.map(file=>[file.server_path,file])),seen=new Set<string>(),files:ArchiveManifestFile[]=[];
 for(const item of manifest){
  if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.local_path!=='string'||typeof item.remote_name!=='string'
   ||!item.remote_name||/[\\/\u0000-\u001f\u007f]/.test(item.remote_name)||['.','..'].includes(item.remote_name)
   ||!Number.isSafeInteger(item.size)||item.size<0||typeof item.md5!=='string'||!/^[a-f0-9]{32}$/i.test(item.md5))return null;
  const path=resolve(item.local_path),reference=expected.get(path);
  if(!reference||seen.has(path)||reference.size_bytes!==item.size||item.sha256!==undefined&&item.sha256!==reference.sha256)return null;
  seen.add(path);files.push({remote_name:item.remote_name,local_path:path,size:item.size,md5:item.md5.toLowerCase(),sha256:reference.sha256});
 }
 if(required.some(file=>!seen.has(file.server_path)))return null;
 return files;
}
