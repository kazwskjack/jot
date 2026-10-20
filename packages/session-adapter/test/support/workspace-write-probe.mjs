// Disposable installed-runtime fixture, not an application command or provider.
import assert from 'node:assert/strict';import {join,resolve,relative,isAbsolute} from 'node:path';import {pathToFileURL} from 'node:url';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES,base=resolve(process.env.JOT_TEST_TMP??''),root=resolve(process.argv[2]??''),id=process.argv[3];
const rel=relative(base,root);assert.ok(runtime&&process.env.JOT_TEST_TMP&&rel&&!isAbsolute(rel)&&!rel.startsWith('..'));assert.equal(id,'cold');
const modules={};for(const name of ['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl'])modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);
const ctx=new modules.cordis.Context();let handle;
try{
 for(const name of ['dsh-session','dsh-session-projection','dsh-session-persistence-jsonl'])await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root,compression:'none'}:{});
 try{handle=await ctx.sessionPersistence.open(id,'write');process.stdout.write(JSON.stringify({owned:true}));}
 catch(error){process.stdout.write(JSON.stringify({owned:false,error:error.name}));}
}finally{if(handle)await handle.close();await ctx.fiber.dispose();}
