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
 if(electron.app.isReady())electron.dialog.showErrorBox('无法启动 Jot 桌面版',error instanceof Error?error.message:String(error));
 electron.app.quit();
});
