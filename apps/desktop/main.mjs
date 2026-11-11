import {DesktopNotificationJournalStore} from '../../packages/desktop/src/notification-journal-store.mjs';
import {createDesktopStartupView} from './startup-view.mjs';
import {createDesktopRendererRecovery} from './renderer-recovery.mjs';
import {desktopLanguage,desktopText} from './desktop-text.mjs';
import {createDesktopAppearanceStore,configureDesktopHardware} from './appearance-storage.mjs';
import {withoutMissingImage} from '../../packages/desktop/src/light-appearance.mjs';
import {createDesktopDiagnosticLog} from './diagnostic-log.mjs';
import {createDesktopHelp} from './desktop-help.mjs';
import {createLinuxCaptionMenu} from './linux-caption-menu.mjs';
import {createDesktopWindowChrome,windowChromeOptions} from './window-chrome.mjs';
import {createDesktopCaptionMenu} from './caption-menu.mjs';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startLocalBackend} from './backend.mjs';
import {loadHostUpdatePolicy} from './host-update-policy.mjs';
import {createDesktopCommandMenu} from './application-menu.mjs';
import {desktopWebPreferences,isDesktopAppUrl,mayGrantNotificationPermission} from './desktop-security.mjs';
import {buildTrayIconPng} from './tray-icon.mjs';
import {resolveDesktopPaths} from './package-layout.mjs';
import {createDesktopLifecycle} from '../../packages/desktop/src/desktop-lifecycle.mjs';
import {createDesktopPackageLifecycle,readPinnedDesktopBuildMetadata} from '../../packages/desktop/src/portable-package.mjs';
import {registerDesktopIpcHandlers} from '../../packages/desktop/src/ipc-handlers.mjs';
import {createDesktopNotificationRuntime} from '../../packages/desktop/src/notification-runtime.mjs';
import {loadDesktopNotificationState,saveDesktopNotificationState} from '../../packages/desktop/src/notification-state.mjs';
import {createUpdateDownloader} from '../../packages/desktop/src/update-download.mjs';
import {createUpdateStateStore} from '../../packages/desktop/src/update-state.mjs';
import {createDesktopUpdateLifecycle} from '../../packages/desktop/src/update-lifecycle.mjs';
import {startCandidateProbe} from '../../packages/desktop/src/update-candidate-probe.mjs';
import {windowsAuthenticodeVerifier} from '../../packages/desktop/src/platform-signature-verifier.mjs';
import {createDesktopHostSupervisorProducer} from './host-supervisor-producer.mjs';
import {bindDesktopHostSupervisorChannel} from '../../packages/desktop/src/host-supervisor-session.mjs';

const appDirectory=dirname(fileURLToPath(import.meta.url));
const projectRoot=resolve(appDirectory,'../..');

function disabledUpdateLifecycle(reason='desktop_update_host_policy_missing'){
 const unavailable=async()=>{throw new Error('desktop_update_unavailable');};
 return Object.freeze({status:async()=>Object.freeze({enabled:false,reason,phase:null,checking:false,actionPending:false,operationCommands:1,activeCommand:null,cancelPending:false}),check:unavailable,download:unavailable,pause:unavailable,resume:unavailable,cancel:unavailable,activate:unavailable,
  onProgress:()=>()=>{},reconcile:async()=>({enabled:false,reason,state:null}),
  prepareStartup:async({restoredStartupNonce}={})=>restoredStartupNonce!==null&&restoredStartupNonce!==undefined?({start:false,operationId:null,enabled:false,
   reason:'desktop_update_restored_startup_contract_unavailable'}):({start:true,operationId:null,enabled:false}),
  confirmStartup:async()=>({confirmed:false}),confirmRestoredStartup:async()=>({confirmed:false}),
  handleRestoredStartupFailure:async()=>({unknown:false}),handleStartupFailure:async()=>({rolledBack:false}),rollbackPrevious:unavailable});
}

function samePath(first,second){
 const left=resolve(first),right=resolve(second);
 return process.platform==='win32'?left.toLocaleLowerCase('en-US')===right.toLocaleLowerCase('en-US'):left===right;
}

function overlapsPath(first,second){
 const inside=(parent,child)=>{const rel=relative(resolve(parent),resolve(child));return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));};
 return inside(first,second)||inside(second,first);
}

function trustedUpdateVerifier(verifier,policy,allowTestOnly){
 return verifier?.identity==='windows-authenticode-v1'&&typeof verifier.verify==='function'&&policy?.platform==='win32'||
  allowTestOnly===true&&verifier?.identity==='test-only'&&verifier.testOnly===true&&typeof verifier.verify==='function';
}

export function prepareDesktopHardware(app){
 const paths=resolveDesktopPaths({appDataPath:app.getPath('appData'),appDirectory,projectRoot});
 return configureDesktopHardware(app,paths.userDataPath);
}

export async function startDesktop(electron,{startLocalBackendImpl=startLocalBackend,loadJotServer=()=>import('../../src/server.mjs'),updateHostConfig=null,
 createDesktopLifecycleImpl=createDesktopLifecycle,createUpdateLifecycleImpl=createDesktopUpdateLifecycle,allowTestOnlyUpdateVerifier=false,showWindow=true,
 restoredStartupNonce=process.env.JOT_DESKTOP_RESTORED_STARTUP_NONCE??null,supervisorBootstrap=null,startupAppearance=null}={}){
 const {app,BrowserWindow,Menu,Tray,ipcMain,nativeImage,session,dialog}=electron??{};
 if(!app||!BrowserWindow||!Menu||!Tray||!ipcMain||!nativeImage||!session||typeof electron?.Notification!=='function')throw new Error('electron_runtime_invalid');
 app.setName('Jot');
 app.setAppUserModelId?.('com.yunticket.jot');
 const paths=resolveDesktopPaths({appDataPath:app.getPath('appData'),appDirectory,projectRoot});
 const userDataPath=paths.userDataPath;
 app.setPath('userData',userDataPath);
 const hardwareCapabilities=startupAppearance??configureDesktopHardware(app,userDataPath);
 let hostBackend=null,supervisorProducer=null,supervisorPeer=null,supervisorDraining=false,lifecycle=null;
 let supervisorInstallRoot=null,supervisorJournal=null,supervisorProcessContext=null;
 if(supervisorBootstrap){
  const releaseRoot=resolve(supervisorBootstrap.releaseRoot??''),scope=supervisorBootstrap.scope;
  supervisorInstallRoot=resolve(dirname(dirname(releaseRoot)));
  if(supervisorBootstrap.role!=='host'||!supervisorBootstrap.endpoint||!isAbsolute(releaseRoot)||
   basename(dirname(releaseRoot))!=='releases'||!scope||!samePath(join(supervisorInstallRoot,'releases',scope.releaseId),releaseRoot)||
   overlapsPath(supervisorInstallRoot,userDataPath))throw new Error('desktop_host_supervisor_bootstrap_unavailable');
  supervisorJournal=createUpdateStateStore({statePath:join(supervisorInstallRoot,'.jot-state','update-state.json')});
  supervisorProducer=createDesktopHostSupervisorProducer({...supervisorBootstrap,installRoot:supervisorInstallRoot,releaseRoot,
   userDataRoot:userDataPath,getUserDataPath:()=>app.getPath('userData'),journal:supervisorJournal,getBackend:()=>hostBackend,
   getLifecycle:()=>({get phase(){return lifecycle?.phase;},stop:reason=>{supervisorDraining=true;return lifecycle.stop(reason);}}),
   exit:code=>app.exit(code)});
  supervisorProducer.verifyRuntime();
 }
 await mkdir(userDataPath,{recursive:true});
 const statePath=join(userDataPath,'desktop-notifications.json');
 let deviceNotificationEnabled=false;
 const stateStore={
  read:async()=>{const state=await loadDesktopNotificationState(statePath);deviceNotificationEnabled=state.preferences.enabled;return state;},
  write:async state=>{const saved=await saveDesktopNotificationState(statePath,state);deviceNotificationEnabled=saved.preferences.enabled;return saved;}
 };
 let appOrigin='',mainWindow=null,tray=null,removeIpcHandlers=null,quitConfirmed=false,shutdownPromise=null,shuttingDown=false,queuedTaskNavigation=null;
 let permissionRequestHandler=null,permissionCheckHandler=null,diagnostics=null,appearanceStore=null,startupView=null,startupRun=null;
 const report=error=>{try{diagnostics?.record('desktop-error',{error});}catch{}console.error('[Jot desktop]',error);};
 const restoreWindow=()=>{
  if(!showWindow||!mainWindow||mainWindow.isDestroyed())return;
  if(mainWindow.isMinimized())mainWindow.restore();
  mainWindow.show();mainWindow.focus();
 };
 const openNotificationSettings=()=>{
  const target=mainWindow;
  if(!target||target.isDestroyed())return;
  restoreWindow();
  if(mainWindow!==target||target.isDestroyed()||target.webContents.isDestroyed?.())return;
  target.webContents.send('desktop:open-notification-settings');
 };
 const deliverPendingTaskNavigation=target=>{
  if(!queuedTaskNavigation||!target||target.isDestroyed())return;
  const contents=target.webContents;
  if(contents.isCrashed?.()||(contents.isLoadingMainFrame?.()??contents.isLoading()))return;
  try{contents.send('desktop:open-task',queuedTaskNavigation);queuedTaskNavigation=null;}catch{}
 };
 const permissionStatus=async()=>{
  if(!mainWindow||mainWindow.isDestroyed())return 'unknown';
  try{
   const status=await mainWindow.webContents.executeJavaScript("typeof Notification==='undefined'?'unsupported':Notification.permission");
   return ['granted','denied','default'].includes(status)?status:'unknown';
  }catch{return 'unknown';}
 };
 const notificationRuntime=createDesktopNotificationRuntime({
  NotificationClass:electron.Notification,stateStore,permission:permissionStatus,
  openTask:async identity=>{
   queuedTaskNavigation=identity;restoreWindow();
   const target=mainWindow;
   if(!target||target.isDestroyed())return;
   if(!target.webContents.isCrashed?.()&&!(target.webContents.isLoadingMainFrame?.()??target.webContents.isLoading()))setTimeout(()=>deliverPendingTaskNavigation(target),0).unref?.();
  }
 });
 let updatePolicy=loadHostUpdatePolicy(updateHostConfig?.policy),updatePackageLifecycle=null,updateLifecycle=disabledUpdateLifecycle(updatePolicy.reason);
 let updateHostEnabled=false;
 if(updatePolicy.enabled){
  try{
   const verifier=updateHostConfig.platformSignatureVerifier??windowsAuthenticodeVerifier;
   const desktopProfile=updatePolicy.profile==='desktop-electron';
   if(desktopProfile&&(!supervisorProducer||!samePath(supervisorInstallRoot,updatePolicy.installRoot)))
    throw new Error('desktop_host_supervisor_bootstrap_unavailable');
   if(!samePath(updatePolicy.userDataRoot,userDataPath)||typeof updateHostConfig.fetchEnvelope!=='function'||
    !desktopProfile&&typeof updateHostConfig.loadActiveRelease!=='function'||
    desktopProfile&&(!updateHostConfig.desktopLifecycle||typeof updateHostConfig.desktopLifecycle.drainActive!=='function'||
     typeof updateHostConfig.desktopLifecycle.probeRelease!=='function'||
     typeof updateHostConfig.releaseOps?.verifyInstalledRelease!=='function'||typeof updateHostConfig.releaseOps?.verifyReleasePackage!=='function'||
     typeof updateHostConfig.releaseOps?.stageRelease!=='function'||typeof updateHostConfig.releaseOps?.activateRelease!=='function'||
     typeof updateHostConfig.releaseOps?.rollbackRelease!=='function')||typeof updateHostConfig.releaseOps?.createRecoveryPoint!=='function'||
    typeof updateHostConfig.releaseOps?.verifyRecoveryPoint!=='function'||typeof dialog?.showMessageBox!=='function'||
    !trustedUpdateVerifier(verifier,updatePolicy,allowTestOnlyUpdateVerifier))
    throw new Error('desktop_update_configuration_invalid');
   const downloadRoot=join(tmpdir(),'Jot-update-cache',`${updatePolicy.product}-${updatePolicy.channel}-${updatePolicy.platform}-${updatePolicy.arch}`);
   if(overlapsPath(downloadRoot,updatePolicy.installRoot)||overlapsPath(downloadRoot,updatePolicy.userDataRoot))throw new Error('desktop_update_download_root_invalid');
   const desktopLifecycle=desktopProfile?{
    async drainActive({releaseId,signal}={}){
     const current=updateHostConfig.releaseOps.readDeploymentState(updatePolicy.installRoot);
     if(current?.active?.releaseId!==releaseId||!lifecycle||lifecycle.phase!=='ready')throw new Error('desktop_update_active_release_mismatch');
     await lifecycle.stop('desktop-update-activation');
     return {releaseId,instanceId:`pid-${process.pid}`,lifecyclePhase:'stopped',backendClosedAt:new Date().toISOString()};
    },
    probeRelease:updateHostConfig.desktopLifecycle.probeRelease
   }:undefined;
   updatePackageLifecycle=createDesktopPackageLifecycle({releaseOps:updateHostConfig.releaseOps,installRoot:updatePolicy.installRoot,
    userDataRoot:updatePolicy.userDataRoot,backupConfig:updatePolicy.backupConfig,hostBackupScript:updateHostConfig.hostBackupScript,
    runCommand:updateHostConfig.runCommand,validationRoot:downloadRoot,profile:updatePolicy.profile,
    ...(desktopLifecycle?{desktopLifecycle}:{})});
   const updateStateStore=createUpdateStateStore({statePath:join(updatePolicy.stateRoot,'update-state.json'),profile:updatePolicy.profile});
   const downloader=createUpdateDownloader({policy:updatePolicy,stateStore:updateStateStore,root:downloadRoot});
   const candidateProbe=desktopProfile?undefined:updateHostConfig.candidateProbe??(options=>startCandidateProbe({...options,startBackend:startLocalBackendImpl}));
   updateLifecycle=createUpdateLifecycleImpl({policy:updatePolicy,releaseOps:updateHostConfig.releaseOps,packageLifecycle:updatePackageLifecycle,
    downloader,stateStore:updateStateStore,platformSignatureVerifier:verifier,candidateProbe,desktopLifecycle,
    getHealthUrl:()=>{if(!appOrigin)throw new Error('desktop_update_health_origin_unavailable');return new URL('/api/capabilities',appOrigin).href;},
    probeRestoredRelease:({releaseId,releaseRoot,expectedTarget,healthUrl,signal}={})=>{
     if(supervisorProducer)return supervisorProducer.ready({scope:supervisorProducer.identity().scope}).then(result=>result.receipt);
     const probeRoot=join(tmpdir(),`Jot-restored-startup-probe-${randomUUID()}`);
     if(overlapsPath(probeRoot,updatePolicy.installRoot)||overlapsPath(probeRoot,updatePolicy.userDataRoot))
      throw new Error('desktop_update_restored_probe_root_invalid');
     return updateHostConfig.desktopLifecycle.probeRelease({releaseId,releaseRoot,expectedTarget,healthUrl,probeRoot,signal});
    },
    exitForHandoff:({exitCode}={})=>{if(exitCode!==75)throw new Error('desktop_update_handoff_exit_invalid');app.exit(75);return true;},
    hostLifecycle:{stop:reason=>lifecycle?.stop(reason)},fetchEnvelope:updateHostConfig.fetchEnvelope,
    confirmActivation:async summary=>{
     const confirmationWindow=mainWindow;
     if(!confirmationWindow||confirmationWindow.isDestroyed())throw new Error('desktop_update_confirmation_unavailable');
     const signerText=summary.signerFingerprints.length?summary.signerFingerprints.join(', '):'未知';
     const response=await dialog.showMessageBox(confirmationWindow,{type:'warning',title:'确认安装 Jot 更新',
      message:`检测到已验证的更新版本 ${summary.version}`,
      detail:`渠道：${summary.channel}\n目标：${summary.platform}/${summary.arch}\n签名者 SHA-256：${signerText}`,
      buttons:['立即更新','稍后'],defaultId:1,cancelId:1,noLink:true});
     return mainWindow===confirmationWindow&&!confirmationWindow.isDestroyed()&&response?.response===0;
    },
    relaunch:async()=>{app.relaunch();app.exit(0);}
   });
   updateHostEnabled=true;
  }catch(error){
   const reason=typeof error?.message==='string'&&error.message.startsWith('desktop_')?error.message:'desktop_update_configuration_invalid';
   updateLifecycle=disabledUpdateLifecycle(reason);updatePackageLifecycle=null;
  }
 }
 const createBackend=async()=>{
  await app.whenReady();
  if(updateHostEnabled){
   const deployment=updateHostConfig.releaseOps.readDeploymentState(updatePolicy.installRoot);
   if(!deployment?.active||typeof deployment.active.releaseId!=='string'||typeof deployment.active.manifestSha256!=='string')throw new Error('desktop_update_active_release_unavailable');
   const active=updatePackageLifecycle.resolveStagedRelease({releaseId:deployment.active.releaseId,expectedManifestSha256:deployment.active.manifestSha256});
   if(updatePolicy.profile==='desktop-electron'){
    if(!samePath(dirname(process.execPath),active.releaseRoot))throw new Error('desktop_update_current_release_mismatch');
    const {buildServer}=await loadJotServer();
    if(typeof buildServer!=='function')throw new Error('desktop_update_current_loader_invalid');
    return startLocalBackendImpl({buildServer,diagnostics,userDataPath:updatePolicy.userDataRoot,publicRoot:join(active.releaseRoot,'dist')});
   }
   const loaded=await updateHostConfig.loadActiveRelease({policy:updatePolicy,releaseOps:updateHostConfig.releaseOps,releaseId:deployment.active.releaseId,
    manifestSha256:deployment.active.manifestSha256,releaseRoot:active.releaseRoot});
   if(!loaded||typeof loaded.buildServer!=='function')throw new Error('desktop_update_active_loader_invalid');
   return startLocalBackendImpl({buildServer:loaded.buildServer,diagnostics,userDataPath:updatePolicy.userDataRoot,publicRoot:join(active.releaseRoot,'dist')});
  }
  const {buildServer}=await loadJotServer();
  return startLocalBackendImpl({buildServer,diagnostics,userDataPath,publicRoot:paths.publicRoot});
 };
 const backendFactory=async()=>{hostBackend=await createBackend();return hostBackend;};
 const getLanguage=()=>appearanceStore?.read().language??desktopLanguage(app);
 const windowAppearance=()=>{
  const nativeTheme=electron.nativeTheme,persistedAppearance=appearanceStore?.read(),initialMode=persistedAppearance?.stored?persistedAppearance.themeMode:'system';
  if(nativeTheme&&nativeTheme.themeSource!==initialMode)nativeTheme.themeSource=initialMode;
  const resolvedTheme=mode=>mode==='dark'||mode==='system'&&nativeTheme?.shouldUseDarkColors===true?'dark':'light';
  const initialTheme=resolvedTheme(initialMode),initialAppearance=persistedAppearance?.stored?withoutMissingImage(persistedAppearance.lightAppearance,true):null;
  return {nativeTheme,resolvedTheme,initialTheme,initialAppearance,reducedMotion:persistedAppearance?.interfacePreferences?.reducedMotion??'system'};
 };
 const prepareWindowFactory=async existing=>{
  await app.whenReady();if(shuttingDown)throw Error('desktop_startup_cancelled');
  if(existing&&existing===startupView&&mainWindow===existing.window&&!existing.window.isDestroyed()){await existing.render({phase:'loading'});return existing;}
  if(mainWindow&&!mainWindow.isDestroyed())throw Error('desktop_window_already_owned');
  const appearance=windowAppearance(),window=new BrowserWindow({width:1200,height:820,minWidth:880,minHeight:620,show:false,autoHideMenuBar:true,
   ...windowChromeOptions(process.platform,appearance.initialTheme,appearance.initialAppearance),webPreferences:desktopWebPreferences(paths.preloadPath)});
  mainWindow=window;
  let prepared;
  try{
  prepared=createDesktopStartupView({owner:window,getWindow:()=>mainWindow,getAppearance:windowAppearance,language:getLanguage,isQuitting:()=>shuttingDown,
   onQuit:()=>app.quit(),onRetry:()=>runStartup(true),getLogFile:()=>diagnostics?.getFile()??null,shell:electron.shell,showWindow,onError:report,
   onClosed:()=>{if(mainWindow===window)mainWindow=null;}});
  startupView=prepared;await prepared.render({phase:'loading'});return prepared;
  }catch(error){if(prepared)prepared.destroy();else{if(!window.isDestroyed())window.destroy();if(mainWindow===window)mainWindow=null;}throw error;}
 };
 const windowFactory=async(origin,_backend,prepared)=>{
  appOrigin=origin;
  const notificationJournal=_backend?.service?.store?.db?new DesktopNotificationJournalStore(_backend.service.store.db):null;
  await app.whenReady();
  permissionRequestHandler=(webContents,permission,callback,details)=>{
   if(!mainWindow||mainWindow.isDestroyed()||webContents!==mainWindow.webContents||webContents.isDestroyed?.()){callback(false);return;}
   const requestWindow=mainWindow;
   const request={permission,requestingUrl:details?.requestingUrl??webContents?.getURL?.(),appOrigin,mainFrame:details?.isMainFrame===true};
   if(!mayGrantNotificationPermission({...request,deviceEnabled:true})){callback(false);return;}
   void stateStore.read().then(state=>{
    const requestingUrl=webContents?.getURL?.()??'';
    const stillCurrent=mainWindow===requestWindow&&!requestWindow.isDestroyed?.()&&webContents===requestWindow.webContents&&
     !webContents.isDestroyed?.()&&isDesktopAppUrl(requestingUrl,appOrigin);
    callback(stillCurrent&&mayGrantNotificationPermission({...request,requestingUrl,deviceEnabled:state.preferences.enabled}));
   }).catch(()=>callback(false));
  };
  permissionCheckHandler=(webContents,permission,requestingOrigin,details)=>mayGrantNotificationPermission({
   permission,requestingUrl:requestingOrigin,appOrigin,mainFrame:details?.isMainFrame===true&&(!webContents||webContents===mainWindow?.webContents),deviceEnabled:deviceNotificationEnabled
  });
  session.defaultSession.setPermissionRequestHandler(permissionRequestHandler);
  session.defaultSession.setPermissionCheckHandler(permissionCheckHandler);
  const {nativeTheme,resolvedTheme,initialTheme,initialAppearance}=windowAppearance();
  if(prepared){await prepared.render({phase:'opening'});await prepared.release();}
  if(shuttingDown||prepared?.window.isDestroyed())throw Error('desktop_startup_cancelled');
  const window=prepared?.window??new BrowserWindow({
   width:1200,height:820,minWidth:880,minHeight:620,show:false,autoHideMenuBar:true,...windowChromeOptions(process.platform,initialTheme,initialAppearance),
   webPreferences:desktopWebPreferences(paths.preloadPath)
  });
  mainWindow=window;
  let commandMenu=null,captionMenu=null,windowChrome=null,linuxCaptionMenu=null,desktopHelp=null,rendererRecovery=null,appearanceDocument=0;
  let syncNotificationPermission=null,commandNavigationStarted=null,denyNavigation=null,downloadHandler=null,didFinishLoadHandler=null,renderProcessGoneHandler=null,applySavedAppearance=null,closeHandler=null;
  let recoveryTimer=null,recoveryAttempts=0,stableTimer=null;
  const destroyWindow=(keepWindow=false)=>{
   if(mainWindow===window)notificationRuntime.closeAll();
   if(recoveryTimer)clearTimeout(recoveryTimer);if(stableTimer)clearTimeout(stableTimer);
   if(syncNotificationPermission)window.off('focus',syncNotificationPermission);if(closeHandler)window.off('close',closeHandler);if(applySavedAppearance)nativeTheme?.removeListener?.('updated',applySavedAppearance);
   rendererRecovery?.dispose();desktopHelp?.dispose();linuxCaptionMenu?.dispose();windowChrome?.dispose();captionMenu?.dispose();commandMenu?.reset();if(commandNavigationStarted)window.webContents.off('did-start-navigation',commandNavigationStarted);
   if(didFinishLoadHandler)window.webContents.off('did-finish-load',didFinishLoadHandler);if(renderProcessGoneHandler)window.webContents.off('render-process-gone',renderProcessGoneHandler);
   if(denyNavigation)window.webContents.off('will-navigate',denyNavigation);if(denyNavigation)window.webContents.off('will-redirect',denyNavigation);
   if(downloadHandler)window.webContents.session.off('will-download',downloadHandler);
   removeIpcHandlers?.();removeIpcHandlers=null;
   if(tray&&!tray.isDestroyed())tray.destroy();tray=null;
   if(!keepWindow){if(!window.isDestroyed())window.destroy();if(mainWindow===window)mainWindow=null;}
  };
  try{
  const resetCommandMenu=()=>{captionMenu?.close();linuxCaptionMenu?.invalidate();commandMenu?.reset();};
  commandNavigationStarted=(_event,_url,inPlace,mainFrame)=>{if(mainFrame===true&&inPlace!==true){appearanceDocument+=1;resetCommandMenu();notificationRuntime.closeAll();}};
  syncNotificationPermission=()=>{
   void permissionStatus().then(status=>{
    if(mainWindow!==window||window.isDestroyed()||window.webContents.isDestroyed?.())return;
    notificationRuntime.permissionChanged(status);
    window.webContents.send('desktop:notification-permission',status);
   }).catch(()=>{});
  };
  window.on('focus',syncNotificationPermission);
  denyNavigation=(_event,url)=>{if(!isDesktopAppUrl(url,appOrigin))_event.preventDefault();};
  window.webContents.on('did-start-navigation',commandNavigationStarted);
  window.webContents.on('will-navigate',denyNavigation);
  window.webContents.on('will-redirect',denyNavigation);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  downloadHandler=(event,_item,contents)=>{if(contents===window.webContents)event.preventDefault();};
  window.webContents.session.on('will-download',downloadHandler);
  didFinishLoadHandler=()=>{windowChrome?.publish();deliverPendingTaskNavigation(window);if(recoveryTimer){clearTimeout(recoveryTimer);recoveryTimer=null;}if(stableTimer)clearTimeout(stableTimer);stableTimer=setTimeout(()=>{stableTimer=null;recoveryAttempts=0;},30000);stableTimer.unref?.();};
  renderProcessGoneHandler=(_event,details)=>{
   notificationRuntime.closeAll();
   if(shuttingDown||details?.reason==='clean-exit')return;
   if(stableTimer){clearTimeout(stableTimer);stableTimer=null;}
   resetCommandMenu();
   diagnostics?.record('renderer-process-gone',{reason:details?.reason});
   report(new Error('renderer_process_gone:'+String(details?.reason??'unknown')));
   if(window.isDestroyed())return;
   if(recoveryAttempts>=3){void rendererRecovery?.offer(true);return;}
   if(recoveryTimer)return;
   recoveryAttempts++;
   recoveryTimer=setTimeout(()=>{recoveryTimer=null;if(!shuttingDown&&!window.isDestroyed())void window.loadURL(appOrigin+'/workbench.html').catch(report);},500);
   recoveryTimer.unref?.();
  };
  window.webContents.on('did-finish-load',didFinishLoadHandler);
  window.webContents.on('render-process-gone',renderProcessGoneHandler);
  closeHandler=event=>{if(!shuttingDown&&tray&&!tray.isDestroyed()){event.preventDefault();window.hide();}};window.on('close',closeHandler);
  desktopHelp=createDesktopHelp({app,owner:window,getWindow:()=>mainWindow,appOrigin,dialog,clipboard:electron.clipboard,shell:electron.shell,getReleaseId:()=>supervisorBootstrap?.scope?.releaseId??null,getLogFile:()=>diagnostics?.getFile()??null,language:getLanguage,
   getBuildInfo:()=>{
    if(!supervisorProducer)return null;
    const context=supervisorProducer.identity();
    if(!samePath(context.process.execPath,process.execPath)||!samePath(context.process.releaseRoot,dirname(process.execPath)))return null;
    return readPinnedDesktopBuildMetadata({packageRoot:context.process.releaseRoot,releaseId:context.scope.releaseId,expectedManifestSha256:context.scope.manifestSha256,expectedTarget:context.target});
   },onError:report});
  commandMenu=createDesktopCommandMenu({Menu,getWindow:()=>mainWindow,appOrigin,restoreWindow,openNotificationSettings,requestQuit:()=>app.quit(),help:action=>desktopHelp.run(action),isUnavailable:()=>rendererRecovery?.isUnresponsive()===true,language:getLanguage});
  if(process.platform==='win32'||process.platform==='linux')window.setMenuBarVisibility(false);
  if(process.platform==='win32'||process.platform==='linux')captionMenu=createDesktopCaptionMenu({owner:window,getWindow:()=>mainWindow,appOrigin,Menu,getTemplate:()=>commandMenu.template(true),getCursor:typeof electron.screen?.getCursorScreenPoint==='function'?()=>electron.screen.getCursorScreenPoint():null});
  if(['win32','linux','darwin'].includes(process.platform))windowChrome=createDesktopWindowChrome({owner:window,getWindow:()=>mainWindow,appOrigin,initialTheme,initialAppearance,getMenus:()=>commandMenu.template().map(item=>item.id).filter(id=>typeof id==='string')});
  const refreshTray=()=>{
   if(!tray||tray.isDestroyed())return;const zh=getLanguage()==='zh-CN';
   tray.setContextMenu(Menu.buildFromTemplate([{label:zh?'显示 Jot':'Show Jot',click:restoreWindow},{label:zh?'任务通知设置':'Task Notification Settings',click:openNotificationSettings},{type:'separator'},{label:zh?'退出':'Quit Jot',click:()=>app.quit()}]));
  };
  applySavedAppearance=()=>{
   if(shuttingDown||mainWindow!==window||window.isDestroyed()||window.webContents.isDestroyed?.())return;
   const value=appearanceStore?.read();if(!value?.stored)return;
   try{if(nativeTheme&&nativeTheme.themeSource!==value.themeMode)nativeTheme.themeSource=value.themeMode;
    windowChrome?.syncPreferences({theme:resolvedTheme(value.themeMode),appearance:value.lightAppearance});
    if(commandMenu?.refresh()){captionMenu?.close();linuxCaptionMenu?.invalidate();refreshTray();}
   }catch(error){report(error);}
  };
  nativeTheme?.on?.('updated',applySavedAppearance);
  rendererRecovery=createDesktopRendererRecovery({owner:window,getWindow:()=>mainWindow,appOrigin,dialog,isQuitting:()=>shuttingDown,language:getLanguage,
   onUnavailable:resetCommandMenu,onResponsive:()=>{if(!window.isDestroyed())window.webContents.send('desktop:menu-refresh');},onDiagnostic:kind=>diagnostics?.record(kind),onError:report});
  if(process.platform==='linux')linuxCaptionMenu=createLinuxCaptionMenu({owner:window,getWindow:()=>mainWindow,appOrigin,getTemplate:()=>commandMenu.template(true),getEpoch:()=>commandMenu.getEpoch()});
  try{
   tray=new Tray(nativeImage.createFromBuffer(buildTrayIconPng()));
   tray.setToolTip('Jot');
   refreshTray();
   tray.on('click',restoreWindow);
  }catch(error){report(new Error('system_tray_unavailable:'+String(error?.message??error)));}
  const appearanceContext=()=>{if(shuttingDown||!appearanceStore)throw Error('desktop_appearance_unavailable');const frame=window.webContents.mainFrame,admittedDocument=appearanceDocument;return()=>appearanceDocument===admittedDocument&&mainWindow===window&&!window.isDestroyed()&&!window.webContents.isDestroyed?.()&&window.webContents.mainFrame===frame&&!(window.webContents.isLoadingMainFrame?.()??window.webContents.isLoading())&&!window.webContents.isCrashed?.()&&isDesktopAppUrl(window.webContents.getURL(),appOrigin);};
  removeIpcHandlers=registerDesktopIpcHandlers({
   ipcMain,appOrigin,getWindow:()=>mainWindow,stateStore,notificationRuntime,notificationJournal,
   readPermission:permissionStatus,updateLifecycle,setMenuState:value=>{
    if(rendererRecovery?.isUnresponsive()){resetCommandMenu();return;}
    const reset=value.owner_scope!==commandMenu.getState().owner_scope||value.blocked||!value.ready;
    if(reset)captionMenu?.close();commandMenu.setState(value);
    if(reset)linuxCaptionMenu?.invalidate();else linuxCaptionMenu?.refresh();
   },
   appearanceImages:{recover:()=>{const current=appearanceContext();return appearanceStore.recoverImages(current);},save:bytes=>{const current=appearanceContext();return appearanceStore.saveImage(bytes,current);},read:id=>{const current=appearanceContext();return appearanceStore.readImage(id,current);},delete:id=>{const current=appearanceContext();return appearanceStore.deleteImage(id,current);}},
   readAppearanceCapabilities:()=>hardwareCapabilities,readAppearance:()=>appearanceStore?.read()??null,writeAppearance:async request=>{
    if(shuttingDown||!appearanceStore)throw Error('desktop_appearance_unavailable');
    const current=appearanceContext();
    const saved=await appearanceStore.write(request,current);applySavedAppearance();return saved;
   },
   linuxCaptionMenu,readDesktopAbout:()=>desktopHelp.read(),
   readWindowChrome:windowChrome?()=>windowChrome.read():null,setWindowTheme:windowChrome?theme=>windowChrome.setTheme(theme):null,setWindowAppearance:windowChrome?value=>windowChrome.setAppearance(value):null,
   showCaptionMenu:captionMenu?value=>captionMenu.show(value):null,closeCaptionMenu:captionMenu?()=>captionMenu.close():null,
   selectFile:async()=>{
    const parent=mainWindow;
    if(!parent||parent.isDestroyed?.()||typeof dialog?.showOpenDialog!=='function')throw new Error('desktop_file_dialog_unavailable');
    const result=await dialog.showOpenDialog(parent,{properties:['openFile']});
    if(mainWindow!==parent||parent.isDestroyed?.()||result?.canceled===true)return null;
    const selected=result?.filePaths?.[0];
    if(result?.canceled!==false||!Array.isArray(result.filePaths)||result.filePaths.length!==1||
     typeof selected!=='string'||!selected.trim()||!isAbsolute(selected))throw new Error('desktop_file_selection_invalid');
    return selected;
   },
  });
  await window.loadURL(appOrigin+'/workbench.html');if(showWindow)window.show();
  return {destroy:()=>destroyWindow()};
  }catch(error){
   const keep=!!prepared&&!window.isDestroyed();destroyWindow(keep);
   if(keep)try{await prepared.render({phase:'failed',canRetry:false});}catch{prepared.destroy();}
   throw error;
  }
 };
 let startupOperationId=null,startupRestoredStartup=null;
 lifecycle=createDesktopLifecycleImpl({app,backendFactory,windowFactory,prepareWindowFactory,onError:report,beforeStart:async()=>{
  if(!diagnostics){diagnostics=createDesktopDiagnosticLog({userDataPath});diagnostics.record('session-start');}
  if(supervisorBootstrap&&(supervisorBootstrap.scope.restoredNonce!==(restoredStartupNonce??null)))
   throw new Error('desktop_host_supervisor_bootstrap_unavailable');
  if(updateHostEnabled&&updatePolicy.profile==='desktop-electron'){
   if(restoredStartupNonce!==null&&restoredStartupNonce!==undefined){
    if(!supervisorProducer||supervisorBootstrap?.scope.restoredNonce!==restoredStartupNonce)throw new Error('desktop_host_supervisor_bootstrap_unavailable');
    const state=(await createUpdateStateStore({statePath:join(updatePolicy.stateRoot,'update-state.json')}).read()).state;
    if(state?.operation?.id!==supervisorBootstrap.scope.operationId||state.operation.restoredStartup?.generation!==supervisorBootstrap.scope.generation)
     throw new Error('desktop_host_supervisor_bootstrap_unavailable');
    supervisorProducer.identity();
   }
   const deployment=updateHostConfig.releaseOps.readDeploymentState(updatePolicy.installRoot),active=deployment?.active&&
    updatePackageLifecycle.resolveStagedRelease({releaseId:deployment.active.releaseId,expectedManifestSha256:deployment.active.manifestSha256});
   if(!active||!samePath(dirname(process.execPath),active.releaseRoot))throw new Error('desktop_update_current_release_mismatch');
  }
  if(supervisorBootstrap&&!updateHostEnabled&&restoredStartupNonce!==null&&restoredStartupNonce!==undefined){
   const {scope}=supervisorBootstrap,loaded=await supervisorJournal.read(),restored=await supervisorJournal.readRestoredStartup({operationId:scope.operationId});
   if(!loaded.enabled||loaded.state?.operation?.id!==scope.operationId||!restored||restored.nonce!==scope.restoredNonce||
    restored.generation!==scope.generation||restored.state!=='prepared'||restored.previous.releaseId!==scope.releaseId||
    restored.previous.manifestSha256!==scope.manifestSha256||restored.previous.runtimeSha256!==scope.runtimeSha256)
    throw new Error('desktop_host_supervisor_bootstrap_unavailable');
   supervisorProcessContext={pid:process.pid,execPath:process.execPath,releaseRoot:resolve(supervisorBootstrap.releaseRoot)};
   const claimed=await supervisorJournal.claimRestoredStartup({operationId:scope.operationId,previous:restored.previous,
    recovery:restored.recovery,nonce:scope.restoredNonce,processContext:supervisorProcessContext});
   if(claimed?.claimed!==true)throw new Error('desktop_update_restored_startup_replay_forbidden');
   startupRestoredStartup=claimed.receipt;
  }
  const preparation=supervisorProcessContext?{start:true,operationId:null,restoredStartup:startupRestoredStartup}:
   await updateLifecycle.prepareStartup?.({restoredStartupNonce});
  if(preparation?.start===false){if(preparation.rolledBack&&updatePolicy.profile!=='desktop-electron')return false;
   throw new Error(preparation.reason??'desktop_update_startup_recovery_failed');}
  startupOperationId=preparation?.operationId??null;
  startupRestoredStartup=preparation?.restoredStartup??null;
  if(startupRestoredStartup&&process.env.JOT_DESKTOP_RESTORED_STARTUP_NONCE===restoredStartupNonce)
   delete process.env.JOT_DESKTOP_RESTORED_STARTUP_NONCE;
  await app.whenReady();
  if(!appearanceStore)try{appearanceStore=await createDesktopAppearanceStore({userDataPath,language:desktopLanguage(app),decodeImage:bytes=>nativeImage.createFromBuffer(bytes).getSize()});}catch{report(Error('desktop_appearance_unavailable'));}
  return true;
 }});
 app.on('second-instance',restoreWindow);
 app.on('activate',restoreWindow);
 app.on('window-all-closed',()=>{if(!supervisorDraining&&(!tray||tray.isDestroyed()))app.quit();});
 app.on('before-quit',event=>{
  if(quitConfirmed)return;
  event.preventDefault();
  if(shutdownPromise)return;
  shuttingDown=true;notificationRuntime.closeAll();
  if(startupView?.active&&mainWindow===startupView.window&&!startupView.window.isDestroyed()&&lifecycle.phase!=='ready')void startupView.render({phase:'stopping'}).catch(report);
  shutdownPromise=(async()=>{await appearanceStore?.flush();return lifecycle.stop('quit');})().then(async()=>{
   try{await diagnostics?.close();}catch{}
   quitConfirmed=true;app.quit();
  }).catch(error=>{
   report(error);shuttingDown=false;shutdownPromise=null;restoreWindow();
   if(startupView&&mainWindow===startupView.window&&!startupView.window.isDestroyed()&&lifecycle.phase==='failed')void startupView.render({phase:'failed',canRetry:false}).catch(report);
  });
 });
 app.on('will-quit',()=>{
  void supervisorPeer?.dispose();
  removeIpcHandlers?.();
  session.defaultSession.setPermissionRequestHandler(null);
  session.defaultSession.setPermissionCheckHandler(null);
 });
 const retryEligible=()=>!updateHostEnabled&&!supervisorBootstrap&&restoredStartupNonce===null&&!startupOperationId&&!startupRestoredStartup;
 const runStartup=(retry=false)=>{
  if(startupRun||shuttingDown)return startupRun;
  if(retry&&(!retryEligible()||!lifecycle.canRetry))return null;
  startupRun=(retry?lifecycle.retry():lifecycle.start()).then(async result=>{
  if(result?.started===false){if(startupRestoredStartup)throw new Error('desktop_update_restored_startup_not_started');return;}
  if(startupRestoredStartup){
   let confirmation;
   if(supervisorProcessContext){
    const ready=await supervisorProducer.ready({scope:supervisorProducer.identity().scope});
    if(ready.process.pid!==supervisorProcessContext.pid||!samePath(ready.process.execPath,supervisorProcessContext.execPath)||
     !samePath(ready.process.releaseRoot,supervisorProcessContext.releaseRoot))throw new Error('desktop_update_restored_startup_process_invalid');
    confirmation=await supervisorJournal.confirmRestoredStartup({operationId:startupRestoredStartup.operationId,
     previous:startupRestoredStartup.previous,recovery:startupRestoredStartup.recovery,nonce:startupRestoredStartup.nonce,
     processContext:supervisorProcessContext,probeReceipt:ready.receipt});
   }else confirmation=await updateLifecycle.confirmRestoredStartup?.({operationId:startupRestoredStartup.operationId,nonce:startupRestoredStartup.nonce});
   if(confirmation?.confirmed!==true)throw new Error('desktop_update_restored_startup_confirmation_failed');
  }
  else if(startupOperationId)await updateLifecycle.confirmStartup?.({operationId:startupOperationId});
  if(supervisorProducer)supervisorPeer=bindDesktopHostSupervisorChannel({endpoint:supervisorBootstrap.endpoint,producer:supervisorProducer});
 }).catch(async error=>{
  if(supervisorProcessContext&&startupRestoredStartup){
   await supervisorJournal.markRestoredStartupUnknown({operationId:startupRestoredStartup.operationId,nonce:startupRestoredStartup.nonce,
    processContext:supervisorProcessContext}).catch(()=>{});
  }else if(startupRestoredStartup&&typeof updateLifecycle.handleRestoredStartupFailure==='function'){
   try{await updateLifecycle.handleRestoredStartupFailure({operationId:startupRestoredStartup.operationId,nonce:startupRestoredStartup.nonce});}
   catch(recoveryError){report(recoveryError);}
  }
  if(startupOperationId&&typeof updateLifecycle.handleStartupFailure==='function'){
   try{const recovery=await updateLifecycle.handleStartupFailure({operationId:startupOperationId});if(recovery?.rolledBack)return;}
   catch(recoveryError){report(recoveryError);}
  }
  report(error);
  if(updateHostEnabled&&updatePolicy.profile==='desktop-electron'){app.exit(1);return;}
  if(shuttingDown)return;
  if(lifecycle.phase==='failed'&&startupView&&!startupView.window.isDestroyed()&&mainWindow===startupView.window){
   try{await startupView.render({phase:'failed',canRetry:retryEligible()&&lifecycle.canRetry});return;}catch(presentationError){report(presentationError);}
  }
  try{if(!shuttingDown){await app.whenReady();if(!shuttingDown){const language=getLanguage();dialog?.showErrorBox(desktopText('startupTitle',language),desktopText('startupFailure',language));}}}
  catch(presentationError){report(presentationError);}
  finally{app.quit();}
 }).finally(()=>{startupRun=null;});
  return startupRun;
 };
 void runStartup();
 return Object.freeze({lifecycle,notificationRuntime,updateLifecycle,get origin(){return appOrigin;}});
}
