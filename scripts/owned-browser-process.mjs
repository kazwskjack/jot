// Isolated destructive browser tests only. Never discovers or kills user browsers.
import {spawn} from 'node:child_process';
import {readFile,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {browserTestExecutable} from './browser-test-launch.mjs';
const bounded=(promise,ms,label)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));};
const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
const errorChain=error=>{const chain=[];for(let current=error;current&&chain.length<8;current=current.cause)chain.push({name:current.name,message:current.message,code:current.code,stack:current.stack});return chain;};
export async function launchOwnedBrowser(chromium,profile){
 const scratch=resolve('.test-tmp'),childPath=relative(scratch,profile);
 if(!isAbsolute(profile)||!childPath||childPath.startsWith('..')||isAbsolute(childPath))throw Error('browser_test_profile_outside_workspace');
 const executable=await browserTestExecutable(chromium);
 await rm(join(profile,'DevToolsActivePort'),{force:true});
 const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT','LOCALAPPDATA','APPDATA','USERPROFILE'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 const child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--no-sandbox','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{env,windowsHide:true,detached:process.platform!=='win32',stdio:'ignore'});
 const ended=Promise.withResolvers();let terminal=false,failure,processExit,browser,cdpDisconnected=false;
 const diagnostics=()=>({pid:child.pid,processExit,terminal,spawnFailure:failure?errorChain(failure):null,cdpDisconnected,cdpConnected:browser?.isConnected()??false});
 child.once('error',error=>{terminal=true;failure=error;ended.resolve();});child.once('exit',(code,signal)=>{terminal=true;processExit={code,signal};ended.resolve();});
 const terminate=async()=>{
  if(terminal)return;
  if(!Number.isSafeInteger(child.pid)||child.pid<1)throw Error('browser_test_process_identity_invalid');
  if(process.platform==='win32'){
   const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let detail='';
   for(const stream of [killer.stdout,killer.stderr])stream.on('data',chunk=>{if(detail.length<2048)detail+=chunk.toString();});
   const result=await bounded(new Promise((resolve,reject)=>{killer.once('error',reject);killer.once('exit',(code,signal)=>resolve({code,signal}));}),10000,'browser_test_tree_stop_timeout');
   if(result.code!==0&&!terminal){await Promise.race([ended.promise,new Promise(resolve=>setTimeout(resolve,500))]);if(!terminal)throw Error(`browser_test_tree_stop_failed:${result.code??result.signal??'unknown'}:${detail.trim()}`);}
  }else process.kill(-child.pid,'SIGKILL');
  await bounded(ended.promise,10000,'browser_test_process_exit_timeout');
 };
 try{
  const port=await bounded((async()=>{while(!terminal){try{const text=await readFile(join(profile,'DevToolsActivePort'),'utf8'),value=Number(text.split('\n')[0]);if(Number.isInteger(value)&&value>0&&value<65536)return value;}catch{}await pause();}throw failure??Error('browser_test_exited_during_startup');})(),30000,'browser_test_start_timeout');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:10000});browser.on('disconnected',()=>{cdpDisconnected=true;});
  const context=browser.contexts()[0];if(!context)throw Error('browser_test_context_missing');
  return {browser,context,get exited(){return terminal;},get diagnostics(){return diagnostics();},async crash(){
   if(terminal)throw Error('browser_test_already_exited');
   const disconnected=Promise.withResolvers();browser.once('disconnected',()=>disconnected.resolve());
   await terminate();await bounded(disconnected.promise,10000,'browser_test_disconnect_timeout');
   if(browser.isConnected()||!terminal)throw Error('browser_test_crash_unconfirmed');
  },async close(){await terminate();await bounded(browser.close(),3000,'browser_test_connection_close_timeout');}};
 }catch(error){
  const beforeCleanup=diagnostics(),cleanupFailures=[];
  try{await terminate();}catch(cleanupError){cleanupFailures.push({operation:'terminate_after_launch_failure',errors:errorChain(cleanupError)});}
  if(browser)try{await bounded(browser.close(),3000,'browser_test_connection_close_timeout');}catch(cleanupError){cleanupFailures.push({operation:'close_cdp_after_launch_failure',errors:errorChain(cleanupError)});}
  Object.defineProperty(error,'ownedBrowserDiagnostics',{value:{beforeCleanup,afterCleanup:diagnostics(),cleanupFailures},configurable:true});
  throw error;
 }
}
