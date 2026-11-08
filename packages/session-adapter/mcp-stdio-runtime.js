import {createRequire,isBuiltin} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

const SOURCE_SHA256='758d8fc473b700b5d351158d06ce9f9e92c16e8b25497b08bb7bd2122a87f5dd';
const fail=()=>{throw Error('jot_mcp_host_transport_seam_unavailable');};

function importTarget(value){
 if(typeof value==='string')return value;
 if(!value||typeof value!=='object'||Array.isArray(value))fail();
 for(const [condition,target] of Object.entries(value)){
  if(['node','import','default'].includes(condition))return importTarget(target);
 }
 fail();
}

/** Resolve the pinned packages' exact ESM export, including import-only targets. */
async function runtimeImport(specifier,require){
 if(isBuiltin(specifier))return specifier;
 const parts=specifier.split('/'),name=specifier.startsWith('@')?parts.slice(0,2).join('/'):parts[0];
 const subpath=specifier.slice(name.length),key=subpath?'.'+subpath:'.';
 let directory=dirname(require.resolve(specifier));
 for(let depth=0;depth<12;depth++){
  let manifest;
  try{manifest=JSON.parse(await readFile(resolve(directory,'package.json'),'utf8'));}
  catch(error){if(error?.code!=='ENOENT')fail();}
  if(manifest?.name===name){
   const exports=manifest.exports;
   const target=importTarget(exports?.[key]??(key==='.'?exports:undefined));
   if(!target.startsWith('./'))fail();
   const file=resolve(directory,target),path=relative(directory,file);
   if(!path||path==='..'||path.startsWith('../')||path.startsWith('..\\')||isAbsolute(path))fail();
   return pathToFileURL(file).href;
  }
  const parent=dirname(directory);if(parent===directory)break;directory=parent;
 }
 fail();
}

/** Adapt one transport creation site in the locked client, retaining original lifecycle code. */
export async function loadScopedMcpStdioRuntime(entry,onStderr){
 try{
  const require=createRequire(entry),source=(await readFile(entry,'utf8')).replace(/\r\n/g,'\n');
  if(createHash('sha256').update(source).digest('hex')!==SOURCE_SHA256)fail();
  const needle='transport = createTransport(config);';
  if(source.split(needle).length!==2)fail();
  const specifiers=[...new Set([...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(match=>match[1]))];
  const imports=new Map(await Promise.all(specifiers.map(async specifier=>[specifier,await runtimeImport(specifier,require)])));
  const adapted=source.replace(needle,
   'const hostTransportFactory = ctx.get("jotMcpTransportFactory");\n'+
   '\t\t\ttransport = hostTransportFactory ? await hostTransportFactory(config) : createTransport(config);')
   .replace(/\bfrom\s+["']([^"']+)["']/g,(_match,specifier)=>'from '+JSON.stringify(imports.get(specifier)));
  const [plugin,stdio,subprocess]=await Promise.all([
   import('data:text/javascript;base64,'+Buffer.from(adapted+'\n//# sourceURL=jot-dsh-mcp-client-0.2.1-rc.2-host-transport.mjs').toString('base64')),
   import(imports.get('@modelcontextprotocol/client/stdio')),
   import(imports.get('@deepseek-ai/dsh-subprocess')),
  ]);
  if(plugin.name!=='mcp-client'||typeof stdio.StdioClientTransport!=='function'||typeof subprocess.scrubbedParentEnv!=='function')fail();
  return Object.freeze({
   plugin:Object.freeze({...plugin,hostTransportProtocol:1}),
   createTransport(params){
    const transport=new stdio.StdioClientTransport({...params,env:{...subprocess.scrubbedParentEnv(),...params.env},stderr:'pipe'});
    let reported=false;
    transport.stderr?.on('data',()=>{
     if(reported)return;reported=true;
     try{onStderr?.();}catch{}
    });
    return transport;
   },
  });
 }catch{fail();}
}
