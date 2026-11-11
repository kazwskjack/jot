// Native menu presentation adapts PilotDeck 783499ff applicationMenu; retained AGPL-3.0.
import {desktopMenuCommands,emptyDesktopMenuState,parseDesktopMenuState,desktopMenuCommandEnabled} from '../../packages/desktop/src/menu-commands.mjs';
import {isDesktopAppUrl} from './desktop-security.mjs';

export function createDesktopCommandMenu({Menu,getWindow,appOrigin,restoreWindow,openNotificationSettings,requestQuit,platform=process.platform}){
 let state=emptyDesktopMenuState,menuEpoch=0;const windowIdentity=getWindow();
 const dispatch=command=>{
  const window=getWindow(),contents=window?.webContents;
  if(!desktopMenuCommandEnabled(command,state)||!window||window!==windowIdentity||window.isDestroyed()||!contents||contents.isDestroyed?.()
   ||contents.isCrashed?.()||(contents.isLoadingMainFrame?.()??contents.isLoading())||!isDesktopAppUrl(contents.getURL(),appOrigin))return;
  restoreWindow();
  if(getWindow()!==window||window.isDestroyed()||contents.isDestroyed?.())return;
  try{contents.send('desktop:command',Object.freeze({protocol:1,command,owner_scope:state.owner_scope}));}catch{setState(emptyDesktopMenuState);}
 };
 const template=(captureOwner=false)=>{
  const ownerScope=state.owner_scope,epoch=menuEpoch;
  const action=(command,label,accelerator)=>({id:'jot:'+command,label,enabled:desktopMenuCommandEnabled(command,state),...(accelerator?{accelerator}:{}),click:()=>{if(!captureOwner||(state.owner_scope===ownerScope&&menuEpoch===epoch))dispatch(command);}});
  return [
  {id:'menu-jot',label:'Jot',submenu:[{label:'显示 Jot',click:restoreWindow},{label:'任务通知设置',click:openNotificationSettings},action('settings','设置…','CmdOrCtrl+,'),action('check-updates','检查更新…'),...(platform==='darwin'?[{type:'separator'},{role:'services',label:'服务'},{type:'separator'},{role:'hide',label:'隐藏 Jot'},{role:'hideOthers',label:'隐藏其他'},{role:'unhide',label:'显示全部'}]:[]),{type:'separator'},{label:'退出',click:requestQuit}]},
  {id:'menu-file',label:'文件',submenu:[action('new-conversation','新建对话…','CmdOrCtrl+N'),action('new-project','新建项目…','CmdOrCtrl+Shift+N'),{type:'separator'},{role:'close',label:'关闭窗口'}]},
  {id:'menu-edit',label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'},
   {...action('find','查找…','CmdOrCtrl+F'),registerAccelerator:false}]},
  {id:'menu-view',label:'查看',submenu:[{...action('toggle-sidebar','显示工作台导航','CmdOrCtrl+B'),type:'checkbox',checked:state.sidebar_visible,registerAccelerator:false},{type:'separator'},
   {role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'},{role:'togglefullscreen',label:'切换全屏'}]},
  {id:'menu-go',label:'前往',submenu:[action('chat','我的对话'),action('files','共同文件'),action('skills','当前会话技能'),action('scheduled-tasks','持续任务')]},
  ...(platform==='darwin'?[{role:'windowMenu',label:'窗口',submenu:[{role:'minimize',label:'最小化'},{role:'zoom',label:'缩放'},{type:'separator'},{role:'front',label:'全部置于前面'}]}]:[]),
 ];
 };
 const menu=Menu.buildFromTemplate(template());
 const setState=value=>{
  const next=parseDesktopMenuState(value);
  if(next.owner_scope!==state.owner_scope||!next.ready||next.blocked)menuEpoch+=1;
  state=next;
  for(const command of desktopMenuCommands){const item=menu.getMenuItemById('jot:'+command);if(item){item.enabled=desktopMenuCommandEnabled(command,state);if(command==='toggle-sidebar')item.checked=state.sidebar_visible;}}
 };
 Menu.setApplicationMenu(menu);
 return {setState,reset:()=>setState(emptyDesktopMenuState),template,getState:()=>state};
}
