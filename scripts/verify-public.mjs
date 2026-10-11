import {readdir,readFile,lstat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isIP} from 'node:net';

// Review the publishable source tree, never dependencies, runtime data or VCS history.
// Findings contain only a relative file, rule and line number; matched text is never emitted.
// This is a heuristic preflight, not proof that arbitrary secrets or private business data are absent.
const excluded=new Set(['node_modules','dist','.git','.data','.cache','.test-tmp','__pycache__']);
const rules=[
  ['private_key',/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['github_token',/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['model_api_key',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ['cloud_access_key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['messaging_token',/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['bearer_token',/\bBearer\s+[A-Za-z0-9_.-]{24,}/g],
  ['private_local_path',/\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\s"'`<>]+|\/(?:Users|home)\/(?!\$|<|\{|example\b|user\b)[A-Za-z0-9_.-]+\/(?:\.ssh|\.codex|\.aws|\.config)\b/gi],
];
const placeholder=value=>!value||/^(?:<[^>]*>|\$\{[^}]*\}|your[-_ ].*|replace[-_ ].*|change[-_]?me|example(?:[-_ ].*)?|placeholder(?:[-_ ].*)?|dummy(?:[-_ ].*)?|test[-_].*|fake[-_].*)$/i.test(value);
function privateIpv4(host){
  const octets=host.split('.').map(Number);if(octets.length!==4||octets.some(value=>!Number.isInteger(value)||value<0||value>255))return false;
  const [a,b]=octets;return a===0||a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===169&&b===254)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19))||a>=224;
}
function privateIpv6(host){
  if(isIP(host)!==6)return false;
  const halves=host.split('::'),left=halves[0].split(':').filter(Boolean),right=(halves[1]??'').split(':').filter(Boolean);
  const words=(halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(value=>Number.parseInt(value,16));
  if(words.length!==8)return false;
  if((words[0]&0xfe00)===0xfc00||(words[0]&0xffc0)===0xfe80||words.every(value=>value===0))return true;
  if(words.slice(0,5).every(value=>value===0)&&words[5]===0xffff){
    const mapped=[words[6]>>>8,words[6]&255,words[7]>>>8,words[7]&255].join('.');return privateIpv4(mapped);
  }
  return false;
}
const envSecretAssignment=/^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#\r\n]*))/gm;
const codeSecretAssignment=/\b(?:[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token)["']?[ \t]*[:=][ \t]*["']([^"'\r\n]+)["']/gi;

export function contentFindings(text,file){
  const findings=[];
  const add=(rule,index)=>findings.push({file,rule,line:text.slice(0,index).split('\n').length});
  for(const [rule,pattern] of rules){pattern.lastIndex=0;for(const match of text.matchAll(pattern))add(rule,match.index);}
  for(const match of text.matchAll(/https?:\/\/[^\s"'`<>]+/gi)){
    let url;try{url=new URL(match[0].replace(/[),.;]+$/g,''));}catch{continue;}
    const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    const ipv4=/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host),loopback=host==='localhost'||host==='::1'||(ipv4&&host.startsWith('127.'));
    // These explicit fake credentials test rejection; real URL credentials remain findings.
    const testCredentials=file.includes('/test/')&&['example.com','example.test'].includes(host)&&url.username==='test-user'&&url.password==='test-password';
    if((url.username||url.password)&&!testCredentials)add('url_credentials',match.index);
    if(!loopback&&(privateIpv4(host)||privateIpv6(host)))add('private_endpoint',match.index);
    if(/\.(?:internal|corp|lan|local)$/.test(host))add('private_domain',match.index);
  }
  for(const [pattern,minimum] of [[envSecretAssignment,1],[codeSecretAssignment,20]]){
    pattern.lastIndex=0;
    for(const match of text.matchAll(pattern)){
      // Public retry identifiers are not authentication secrets.
      if(pattern===codeSecretAssignment&&text.slice(Math.max(0,match.index-12),match.index).toLowerCase()==='idempotency-'&&/^key["']?\s*[:=]/i.test(match[0]))continue;
      const value=(match[1]??match[2]??match[3]??'').trim();
      if(value.length>=minimum&&!placeholder(value)&&(pattern===envSecretAssignment||/^[A-Za-z0-9_+./=-]+$/.test(value)))add('literal_secret',match.index);
    }
  }
  return findings;
}

export async function scanPublicTree(root){
  root=resolve(root);let files=0;const findings=[];
  async function walk(folder){
    for(const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(excluded.has(entry.name))continue;
      const path=join(folder,entry.name),file=relative(root,path).replace(/\\/g,'/');
      if(entry.isSymbolicLink()){findings.push({file,rule:'symlink_requires_review',line:1});continue;}
      if(entry.isDirectory()){await walk(path);continue;}
      if(!entry.isFile()){findings.push({file,rule:'unsupported_file_type',line:1});continue;}
      files++;
      if((entry.name==='.env'||entry.name.startsWith('.env.'))&&entry.name!=='.env.example')findings.push({file,rule:'private_environment_file',line:1});
      if(/\.(?:sqlite(?:3)?|db|pfx|p12|keystore|log)$/i.test(entry.name)||/^id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$/.test(entry.name))findings.push({file,rule:'private_runtime_file',line:1});
      const info=await lstat(path);if(info.size>20*1024*1024){findings.push({file,rule:'file_requires_manual_review',line:1});continue;}
      findings.push(...contentFindings((await readFile(path)).toString('utf8'),file));
    }
  }
  await walk(root);return {files,findings};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const root=process.argv[2]??fileURLToPath(new URL('../',import.meta.url)),result=await scanPublicTree(root);
    if(result.findings.length){for(const finding of result.findings)console.error(`${finding.file}:${finding.line} [${finding.rule}]`);console.error(`Public review failed: ${result.findings.length} finding(s) across ${result.files} scanned files.`);process.exitCode=1;}
    else console.log(`Public review passed: ${result.files} files scanned. Dependencies, build outputs and runtime data excluded.`);
  }catch{console.error('Public review failed: unable to inspect the requested tree.');process.exitCode=1;}
}
