// Native menu presentation adapts PilotDeck 783499ff applicationMenu; retained AGPL-3.0.
import {desktopMenuCommands,emptyDesktopMenuState,parseDesktopMenuState,desktopMenuCommandEnabled} from '../../packages/desktop/src/menu-commands.mjs';
import {isDesktopAppUrl} from './desktop-security.mjs';

export function createDesktopCommandMenu({Menu,getWindow,appOrigin,restoreWindow,openNotificationSettings,requestQuit}){
 let state=emptyDesktopMenuState;const windowIdentity=getWindow();
 const dispatch=command=>{
  const window=getWindow(),contents=window?.webContents;
  if(!desktopMenuCommandEnabled(command,state)||!window||window!==windowIdentity||window.isDestroyed()||!contents||contents.isDestroyed?.()
   ||contents.isCrashed?.()||(contents.isLoadingMainFrame?.()??contents.isLoading())||!isDesktopAppUrl(contents.getURL(),appOrigin))return;
  restoreWindow();
  if(getWindow()!==window||window.isDestroyed()||contents.isDestroyed?.())return;
  try{contents.send('desktop:command',Object.freeze({protocol:1,command,owner_scope:state.owner_scope}));}catch{setState(emptyDesktopMenuState);}
 };
 const action=(command,label,accelerator)=>({id:'jot:'+command,label,enabled:false,...(accelerator?{accelerator}:{}),click:()=>dispatch(command)});
 const menu=Menu.buildFromTemplate([
  {label:'Jot',submenu:[{label:'显示 Jot',click:restoreWindow},{label:'任务通知设置',click:openNotificationSettings},action('settings','设置…','CmdOrCtrl+,'),action('check-updates','检查更新…'),{type:'separator'},{label:'退出',click:requestQuit}]},
  {label:'文件',submenu:[action('new-conversation','新建对话…','CmdOrCtrl+N'),action('new-project','新建项目…','CmdOrCtrl+Shift+N'),{type:'separator'},{role:'close',label:'关闭窗口'}]},
  {label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'},
   {...action('find','查找…','CmdOrCtrl+F'),registerAccelerator:false}]},
  {label:'查看',submenu:[{...action('toggle-sidebar','显示工作台导航','CmdOrCtrl+B'),type:'checkbox',checked:false,registerAccelerator:false},{type:'separator'},
   {role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'},{role:'togglefullscreen',label:'切换全屏'}]},
  {label:'前往',submenu:[action('chat','我的对话'),action('files','共同文件'),action('skills','当前会话技能'),action('scheduled-tasks','持续任务')]},
 ]);
 const setState=value=>{
  state=parseDesktopMenuState(value);
  for(const command of desktopMenuCommands){const item=menu.getMenuItemById('jot:'+command);if(item){item.enabled=desktopMenuCommandEnabled(command,state);if(command==='toggle-sidebar')item.checked=state.sidebar_visible;}}
 };
 Menu.setApplicationMenu(menu);
 return {setState,reset:()=>setState(emptyDesktopMenuState)};
}
