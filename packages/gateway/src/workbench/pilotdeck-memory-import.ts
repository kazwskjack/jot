import {createHash} from 'node:crypto';
import {posix,win32} from 'node:path';
import type {WorkbenchMemoryImportBundle} from '../../contracts/types.ts';

const formatVersion='clawxmemory-memory-snapshot.v4';
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
type Bundle=Record<string,unknown>&{formatVersion:typeof formatVersion;files:Array<{relativePath:string;content:string}>};
export type PilotdeckMemoryImportSource={bundle:Bundle;summary:WorkbenchMemoryImportBundle};
function invalid():never{throw Error('invalid_memory_import_bundle');}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}

function relativePath(value:unknown){
 if(typeof value!=='string')invalid();
 const path=value.trim().replace(/\\/g,'/');
 if(!path||posix.isAbsolute(path)||win32.isAbsolute(path)||/^[A-Za-z]:/.test(path)||path.includes('\0'))invalid();
 const parts=path.split('/').filter(Boolean);
 if(!parts.length||parts.some(part=>part==='.'||part==='..'))invalid();
 const normalized=parts.join('/');
 if(normalized.startsWith('projects/')||normalized.includes('/project.meta.md'))invalid();
 return normalized;
}
function frontmatter(content:string){
 const values=new Map<string,string>();
 if(!content.startsWith('---\n'))return values;
 const end=content.indexOf('\n---\n',4);if(end<0)return values;
 for(const line of content.slice(4,end).replace(/\r\n/g,'\n').split('\n')){
  const separator=line.indexOf(':');
  if(separator>0)values.set(line.slice(0,separator).trim(),line.slice(separator+1).trim());
 }
 return values;
}
function metadataText(bundle:Bundle,key:string){const value=bundle[key];return typeof value==='string'&&value.length<=128?value:null;}

/** Convert the pinned current-project snapshot into original unverified note inputs, retaining its complete source. */
export function pilotdeckMemoryImport(value:unknown,namespace:string){
 if(!record(value)||value.formatVersion===undefined)return null;
 let encoded:string|undefined;try{encoded=JSON.stringify(value);}catch{invalid();}
 if(typeof encoded!=='string'||encoded.length>5_000_000||value.formatVersion!==formatVersion||value.scope!==undefined&&value.scope!=='current_project'||!Array.isArray(value.files))invalid();
 const bundle=value as Bundle,files:Array<{path:string;content:string}>=[],paths=new Set<string>();
 for(const input of bundle.files){
  if(!record(input)||typeof input.content!=='string')invalid();
  const path=relativePath(input.relativePath);if(paths.has(path))invalid();
  paths.add(path);files.push({path,content:input.content});
 }
 const ordered=[...paths].map(path=>path+'/').sort();
 for(let index=1;index<ordered.length;index++)if(ordered[index]!.startsWith(ordered[index-1]!))invalid();
 const sourceHash=hash(encoded),workspaceId='pilotdeck-'+hash(namespace);
 const items:Array<Record<string,unknown>>=[];
 let globalFiles=0,memoryFiles=0,sourceOnlyFiles=0,totalBytes=0,deprecatedFiles=0;
 for(const file of files){
  totalBytes+=Buffer.byteLength(file.content,'utf8');
  if(file.path.startsWith('global/')){globalFiles++;continue;}
  const header=frontmatter(file.content),type=header.get('type'),scope=header.get('scope');
  const note=/^(Project|Feedback|GeneralProjects)\/[^/]+\.md$/.test(file.path)
   &&!['MEMORY.md','project.meta.md'].includes(file.path.split('/').at(-1)!)
   &&['project','feedback','general_project_meta'].includes(type??'')&&scope==='project';
  const projectMeta=file.path==='project.meta.md'&&!!header.get('project_name')?.trim();
  if((!note&&!projectMeta)||!file.content.trim()){sourceOnlyFiles++;continue;}
  memoryFiles++;
  const deprecated=header.get('deprecated')==='true';if(deprecated)deprecatedFiles++;
  const fileHash=hash(file.content),pathHash=hash(file.path),version=1;
  let offset=0,part=0;
  while(offset<file.content.length){
   let end=Math.min(file.content.length,offset+20_000);
   if(end<file.content.length&&file.content.charCodeAt(end-1)>=0xd800&&file.content.charCodeAt(end-1)<=0xdbff)end--;
   const content=file.content.slice(offset,end);offset=end;part++;
   if(!content.trim())continue;
   if(items.length===200)throw Error('memory_import_bundle_note_limit');
   const memoryId=`pilotdeck-${pathHash}-${part}`,status=deprecated?'superseded':'active';
   const provenance=[{kind:'pilotdeck_snapshot',reference:sourceHash},{kind:'pilotdeck_file',reference:file.path.length<=2048?file.path:`sha256:${pathHash}`},{kind:'sha256',reference:fileHash}];
   items.push({memory_id:memoryId,workspace_id:workspaceId,project_id:'current_project',scope:'project',agent_id:null,
    content,verified:false,version,status,provenance,source_revision:fileHash,expires_at:null,supersedes:null,
    history:[{version,content,verified:false,status}]});
  }
 }
 const exported=typeof bundle.exportedAt==='string'?Date.parse(bundle.exportedAt):NaN;
 const summary:WorkbenchMemoryImportBundle={format_version:formatVersion,sha256:sourceHash,file_count:files.length,
  global_file_count:globalFiles,memory_file_count:memoryFiles,source_only_file_count:sourceOnlyFiles,deprecated_file_count:deprecatedFiles,
  total_utf8_bytes:totalBytes,metadata:{exported_at:metadataText(bundle,'exportedAt'),last_indexed_at:metadataText(bundle,'lastIndexedAt'),
   last_dream_at:metadataText(bundle,'lastDreamAt'),last_dream_status:metadataText(bundle,'lastDreamStatus'),
   last_dream_summary_chars:typeof bundle.lastDreamSummary==='string'?bundle.lastDreamSummary.length:0,
   case_trace_count:Array.isArray(bundle.recentCaseTraces)?bundle.recentCaseTraces.length:0,
   index_trace_count:Array.isArray(bundle.recentIndexTraces)?bundle.recentIndexTraces.length:0,
   dream_trace_count:Array.isArray(bundle.recentDreamTraces)?bundle.recentDreamTraces.length:0},execution_authorized:false};
 return {document:{schema_version:1,workspace_id:workspaceId,exported_at:Number.isFinite(exported)?new Date(exported).toISOString():'1970-01-01T00:00:00.000Z',items},
  source:{bundle,summary} satisfies PilotdeckMemoryImportSource};
}
