import {desktopLanguage,desktopText} from './desktop-text.mjs';
import * as electron from 'electron';
import {startDesktop,prepareDesktopHardware} from './main.mjs';
import {desktopUpdateHostConfig} from './host-update-config.mjs';
import {consumeDesktopHostSupervisorBootstrap,startDesktopHostSupervisorProbe} from './host-supervisor-bootstrap.mjs';

void (async()=>{
 const startupAppearance=process.argv.includes('--jot-runtime-probe')?null:prepareDesktopHardware(electron.app);
 const bootstrap=await consumeDesktopHostSupervisorBootstrap(desktopUpdateHostConfig);
 if(bootstrap?.role==='probe')return startDesktopHostSupervisorProbe(electron,{config:desktopUpdateHostConfig,bootstrap});
 return startDesktop(electron,{updateHostConfig:desktopUpdateHostConfig,supervisorBootstrap:bootstrap,startupAppearance});
})().catch(error=>{
 console.error('[Jot desktop]',error);
 try{if(electron.app.isReady()){const language=desktopLanguage(electron.app);electron.dialog.showErrorBox(desktopText('startupTitle',language),desktopText('startupFailure',language));}}
 finally{electron.app.quit();}
});
