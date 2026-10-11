import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {contentFindings} from './verify-public.mjs';

/** Read-only review of every reachable commit tree, commit message and index.
 * No worktree exclusions: a previously committed runtime file must be found.
 * Matched values are never printed. Binary findings require separate review.
 * Heuristic findings are not proof that arbitrary sensitive content is absent. */
export async function scanGitPublic(root,{privateIdentities=[]}={}){
 if(!Array.isArray(privateIdentities)||privateIdentities.some(x=>typeof x!=='string'||!x.trim()||x.length>500))throw new Error('git_review_policy_invalid');
 root=resolve(root);const identities=privateIdentities.map(x=>x.toLowerCase());
 const git=(...args)=>{try{return execFileSync('git',['--no-pager','-c',`safe.directory=${root}`,'-C',root,...args],{maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});}catch{throw new Error('git_review_read_failed');}};
 const findings=[],objects=new Map();let commits=0;
 const hasIdentity=text=>identities.some(x=>text.toLowerCase().includes(x));
 const add=(file,rule,object,line=1)=>findings.push({file:hasIdentity(file)?'<private-path>':file,rule,object,line});
 const scan=(text,file,object)=>{
  for(const item of contentFindings(text,file))add(file,item.rule,object,item.line);
  if(hasIdentity(text))add(file,'private_identity',object);
 };
 const remember=(hash,file,mode)=>{
  if(!/^[a-f0-9]{40,64}$/.test(hash))throw new Error('git_review_object_invalid');
  if(mode==='160000'){add(file,'submodule_requires_review',hash);return;}
  if(mode==='120000')add(file,'symlink_requires_review',hash);
  if(hasIdentity(file))add(file,'private_identity_path',hash);
  if(/(?:^|\/)(?:\.env(?:\.[^/]*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)$/.test(file)&&!file.endsWith('.env.example'))add(file,'private_runtime_file',hash);
  if(/\.(?:sqlite(?:3)?|db|pfx|p12|keystore|log)$/i.test(file))add(file,'private_runtime_file',hash);
  const names=objects.get(hash)??new Set();names.add(file);objects.set(hash,names);
 };
 for(const commit of git('rev-list','--all').toString('utf8').trim().split('\n').filter(Boolean)){
  commits++;scan(git('show','-s','--format=%an%n%ae%n%cn%n%ce%n%B',commit).toString('utf8'),'<commit-metadata>',commit);
  for(const entry of git('ls-tree','-rz','--full-tree',commit).toString('utf8').split('\0').filter(Boolean)){
   const match=/^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);if(!match)throw new Error('git_review_tree_invalid');remember(match[2],match[3],match[1]);
  }
 }
 for(const entry of git('ls-files','--stage','-z').toString('utf8').split('\0').filter(Boolean)){
  const match=/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);if(!match)throw new Error('git_review_index_invalid');
  if(match[3]!=='0')add(match[4],'unmerged_index',match[2]);remember(match[2],match[4],match[1]);
 }
 for(const [object,files] of objects){
  const size=Number(git('cat-file','-s',object).toString('utf8').trim());
  if(!Number.isSafeInteger(size)||size<0)throw new Error('git_review_size_invalid');
  if(size>20*1024*1024){for(const file of files)add(file,'large_blob_requires_review',object);continue;}
  const bytes=git('cat-file','blob',object);let text;
  try{if(bytes.includes(0))throw new Error();text=new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{for(const file of files)add(file,'binary_requires_review',object);continue;}
  for(const file of files)scan(text,file,object);
 }
 return {commits,blobs:objects.size,findings};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const result=await scanGitPublic(process.argv[2]??'.');for(const finding of result.findings)console.error(JSON.stringify(finding));console.log(JSON.stringify({commits:result.commits,blobs:result.blobs,findings:result.findings.length}));if(result.findings.length)process.exitCode=1;}
 catch{console.error('Git public review failed: unable to complete read-only inspection.');process.exitCode=1;}
}
