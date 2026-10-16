// Isolated destructive browser tests only. Never discovers or kills user browsers.
import {spawn} from 'node:child_process';
import {access,readFile,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
const bounded=(promise,ms,label)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));};
const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
export async function launchOwnedBrowser(chromium,profile){
 const scratch=resolve('.test-tmp'),childPath=relative(scratch,profile);
 if(!isAbsolute(profile)||!childPath||childPath.startsWith('..')||isAbsolute(childPath))throw Error('browser_test_profile_outside_workspace');
 let executable=chromium.executablePath();
 if(process.platform==='win32'){
  const candidates=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean).map(root=>join(root,'Microsoft','Edge','Application','msedge.exe'));
  executable=undefined;for(const file of candidates){try{await access(file);executable=file;break;}catch{}}
  if(!executable)throw Error('browser_test_edge_unavailable');
 }
 await rm(join(profile,'DevToolsActivePort'),{force:true});
 const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT','LOCALAPPDATA','APPDATA','USERPROFILE'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 const child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--no-sandbox','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{env,windowsHide:true,detached:process.platform!=='win32',stdio:'ignore'});
 const ended=Promise.withResolvers();let terminal=false,failure,browser;
 child.once('error',error=>{terminal=true;failure=error;ended.resolve();});child.once('exit',()=>{terminal=true;ended.resolve();});
 const terminate=async()=>{
  if(terminal)return;
  if(!Number.isSafeInteger(child.pid)||child.pid<1)throw Error('browser_test_process_identity_invalid');
  if(process.platform==='win32'){
   const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
   const result=await bounded(new Promise((resolve,reject)=>{killer.once('error',reject);killer.once('exit',resolve);}),10000,'browser_test_tree_stop_timeout');
   if(result!==0&&!terminal)throw Error('browser_test_tree_stop_failed');
  }else process.kill(-child.pid,'SIGKILL');
  await bounded(ended.promise,10000,'browser_test_process_exit_timeout');
 };
 try{
  const port=await bounded((async()=>{while(!terminal){try{const text=await readFile(join(profile,'DevToolsActivePort'),'utf8'),value=Number(text.split('\n')[0]);if(Number.isInteger(value)&&value>0&&value<65536)return value;}catch{}await pause();}throw failure??Error('browser_test_exited_during_startup');})(),30000,'browser_test_start_timeout');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:10000});
  const context=browser.contexts()[0];if(!context)throw Error('browser_test_context_missing');
  return {browser,context,get exited(){return terminal;},async crash(){
   if(terminal)throw Error('browser_test_already_exited');
   const disconnected=Promise.withResolvers();browser.once('disconnected',()=>disconnected.resolve());
   await terminate();await bounded(disconnected.promise,10000,'browser_test_disconnect_timeout');
   if(browser.isConnected()||!terminal)throw Error('browser_test_crash_unconfirmed');
  },async close(){await terminate();await bounded(browser.close(),3000,'browser_test_connection_close_timeout');}};
 }catch(error){await terminate();if(browser)await bounded(browser.close(),3000,'browser_test_connection_close_timeout').catch(()=>{});throw error;}
}
