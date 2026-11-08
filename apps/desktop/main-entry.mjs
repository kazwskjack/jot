import * as electron from 'electron';
import {startDesktop} from './main.mjs';
import {desktopUpdateHostConfig} from './host-update-config.mjs';
import {consumeDesktopHostSupervisorBootstrap,startDesktopHostSupervisorProbe} from './host-supervisor-bootstrap.mjs';

void (async()=>{
 const bootstrap=await consumeDesktopHostSupervisorBootstrap(desktopUpdateHostConfig);
 if(bootstrap?.role==='probe')return startDesktopHostSupervisorProbe(electron,{config:desktopUpdateHostConfig,bootstrap});
 return startDesktop(electron,{updateHostConfig:desktopUpdateHostConfig,supervisorBootstrap:bootstrap});
})().catch(error=>{
 console.error('[Jot desktop]',error);
 if(electron.app.isReady())electron.dialog.showErrorBox('无法启动 Jot 桌面版',error instanceof Error?error.message:String(error));
 electron.app.quit();
});
