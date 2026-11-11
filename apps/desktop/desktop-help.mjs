// Native help/about adapts PilotDeck 783499ff desktopAbout/applicationMenu; AGPL-3.0.
import {mkdir} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {release} from 'node:os';
import {isDesktopAppUrl} from './desktop-security.mjs';
const projectWebsite='https://github.com/kazwskjack/jot';
const links=Object.freeze({docs:projectWebsite+'#readme',issues:projectWebsite+'/issues',website:projectWebsite});
const safe=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f\x7f]/.test(value)?value:null;
export function createDesktopHelp({app,owner,getWindow,appOrigin,dialog,clipboard,shell,getReleaseId,getBuildInfo,getLogFile,onError=()=>{}}){
 let disposed=false,pending=false;
 const valid=()=>!disposed&&getWindow()===owner&&!owner.isDestroyed()&&!owner.webContents.isDestroyed?.()&&!owner.webContents.isCrashed?.()&&isDesktopAppUrl(owner.webContents.getURL(),appOrigin);
 const read=()=>{
  if(!valid())throw Error('desktop_help_window_unavailable');
  const versions=Object.freeze({electron:safe(process.versions.electron),chrome:safe(process.versions.chrome),node:safe(process.versions.node)});
  const releaseId=safe(getReleaseId?.());
  let build=null;try{const value=getBuildInfo?.();if(value&&value.release_id===releaseId&&safe(value.package_version)&&/^[a-f0-9]{40}$/.test(value.source_commit??'')&&/^[a-f0-9]{64}$/.test(value.manifest_sha256??''))build=value;}catch{}
  const info={protocol:1,name:'Jot',version:safe(app.getVersion?.()),platform:process.platform,arch:process.arch,os_release:safe(release()),
   build_time:null,source_commit:build?.source_commit??null,package_version:build?.package_version??null,package_manifest_sha256:build?.manifest_sha256??null,
   build_source:build?'running-release-manifest':'unavailable',launcher_release_id:releaseId,versions,project_website:projectWebsite,
   license:'Project package declaration: Apache-2.0; included PilotDeck components: AGPL-3.0; see THIRD_PARTY_NOTICES.md'};
  const versionInformation=['Jot: '+(info.version??'not provided'),'OS: '+info.platform+' '+(info.os_release??'unknown')+' ('+info.arch+')',
   ...Object.entries(versions).filter(([,value])=>value).map(([name,value])=>name+': '+value),
   'Package version: '+(info.package_version??'not provided'),'Build time: not provided','Source commit: '+(info.source_commit??'not provided'),
   'Build source: '+info.build_source,...(info.package_manifest_sha256?['Package manifest SHA-256: '+info.package_manifest_sha256]:[]),...(releaseId?['Launcher release: '+releaseId]:[]),info.license,'PilotDeck components: Copyright © OpenBMB',projectWebsite].join('\n');
  return Object.freeze({...info,version_information:versionInformation});
 };
 const copy=info=>{if(!valid()||typeof clipboard?.writeText!=='function')throw Error('desktop_help_clipboard_unavailable');clipboard.writeText(info.version_information);};
 const openWebsite=async kind=>{
  if(!valid()||!Object.hasOwn(links,kind)||typeof shell?.openExternal!=='function')throw Error('desktop_help_link_unavailable');
  await shell.openExternal(links[kind]);
 };
 const about=async()=>{
  const info=read();if(typeof dialog?.showMessageBox!=='function')throw Error('desktop_help_dialog_unavailable');
  const result=await dialog.showMessageBox(owner,{type:'info',title:'关于 Jot',message:'Jot',
   detail:['AI 工作台：对话、共同文件、技能与持续任务。','',info.version_information,'','吸收组件：PilotDeck（OpenBMB）。第三方许可见 THIRD_PARTY_NOTICES.md。'].join('\n'),
   buttons:['确定','复制版本信息','项目主页'],defaultId:0,cancelId:0,noLink:true});
  if(!valid())return;
  if(result?.response===1)copy(info);else if(result?.response===2)await openWebsite('website');
 };
 const run=async action=>{
  if(!valid()||pending)return Object.freeze({accepted:false});
  if(!['docs','issues','logs','log-directory','version','about'].includes(action))throw Error('desktop_help_action_invalid');
  pending=true;
  try{
   if(action==='version')copy(read());
   else if(action==='about')await about();
   else if(action==='logs'||action==='log-directory'){
    const provided=await getLogFile?.();
    const path=action==='logs'?provided:typeof provided==='string'&&isAbsolute(provided)?dirname(provided):app.getPath('logs');
    if(typeof path!=='string'||!isAbsolute(path)||typeof shell?.openPath!=='function')throw Error('desktop_help_logs_unavailable');
    if(action==='log-directory')await mkdir(path,{recursive:true});if(!valid())return Object.freeze({accepted:false});
    if(await shell.openPath(path))throw Error('desktop_help_logs_open_failed');
   }else await openWebsite(action);
   return Object.freeze({accepted:true});
  }catch(error){
   try{onError(error);}catch{}
   if(valid()&&typeof dialog?.showMessageBox==='function')try{await dialog.showMessageBox(owner,{type:'error',title:'Jot',message:'暂时无法打开此帮助入口，请稍后重试。',buttons:['确定'],noLink:true});}catch{}
   return Object.freeze({accepted:false});
  }finally{pending=false;}
 };
 const dispose=()=>{disposed=true;owner.off('closed',dispose);};owner.on('closed',dispose);
 return Object.freeze({read,run,dispose});
}
