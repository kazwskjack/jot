import {fork} from 'node:child_process';import {fileURLToPath} from 'node:url';
/** Synthetic process controller only. No fixture hooks are product settings. */
export function nativeGitPeer(config){
 const child=fork(fileURLToPath(new URL('../git/fixtures/native-git-peer.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']}),pending=[],messages=[];let failure,diagnostic='';
 child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-2048)});
 const exited=new Promise(done=>child.once('exit',code=>{done(code);for(const item of pending.splice(0))item.reject(Error('native_index_peer_exit:'+code+':'+diagnostic))}));
 child.on('message',value=>{if(value.type==='failed'){failure=Error(value.code+':'+value.diagnostic);for(const item of pending.splice(0))item.reject(failure);return}const at=pending.findIndex(p=>p.type===value.type);if(at>=0)pending.splice(at,1)[0].done(value);else messages.push(value)});
 const take=type=>{if(failure)return Promise.reject(failure);const at=messages.findIndex(v=>v.type===type);if(at>=0)return Promise.resolve(messages.splice(at,1)[0]);return new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('native_index_peer_timeout:'+type)),20000);pending.push({type,done:value=>{clearTimeout(timer);done(value)},reject:error=>{clearTimeout(timer);reject(error)}})})};
 child.send({type:'start',config});return{take,exited,send:value=>child.send(value),async stop(){if(child.exitCode!==null)return;child.send({type:'stop'});await Promise.race([exited,new Promise(done=>setTimeout(done,5000))]);if(child.exitCode===null){child.kill();await exited}}};
}
