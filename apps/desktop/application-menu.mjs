// Native menu presentation adapts PilotDeck 783499ff applicationMenu; retained AGPL-3.0.
import {desktopMenuCommands,emptyDesktopMenuState,parseDesktopMenuState,desktopMenuCommandEnabled} from '../../packages/desktop/src/menu-commands.mjs';
import {isDesktopAppUrl} from './desktop-security.mjs';

export function createDesktopCommandMenu({Menu,getWindow,appOrigin,restoreWindow,openNotificationSettings,requestQuit,help=null,isUnavailable=()=>false,language=()=>'zh-CN',platform=process.platform}){
 let state=emptyDesktopMenuState,menuEpoch=0;const windowIdentity=getWindow();
 const dispatch=command=>{
  const window=getWindow(),contents=window?.webContents;
  if(isUnavailable()||!desktopMenuCommandEnabled(command,state)||!window||window!==windowIdentity||window.isDestroyed()||!contents||contents.isDestroyed?.()
   ||contents.isCrashed?.()||(contents.isLoadingMainFrame?.()??contents.isLoading())||!isDesktopAppUrl(contents.getURL(),appOrigin))return;
  restoreWindow();
  if(getWindow()!==window||window.isDestroyed()||contents.isDestroyed?.())return;
  try{contents.send('desktop:command',Object.freeze({protocol:1,command,owner_scope:state.owner_scope}));}catch{setState(emptyDesktopMenuState);}
 };
 const text=(zh,en)=>language()==='zh-CN'?zh:en;
 const template=(captureOwner=false)=>{
  const ownerScope=state.owner_scope,epoch=menuEpoch;
  const helpItem=(kind,label)=>({id:'jot-help:'+kind,label,enabled:typeof help==='function',click:()=>{if(!captureOwner||(state.owner_scope===ownerScope&&menuEpoch===epoch))void help?.(kind);}});
  const action=(command,label,accelerator)=>({id:'jot:'+command,label,enabled:desktopMenuCommandEnabled(command,state),...(accelerator?{accelerator}:{}),click:()=>{if(!captureOwner||(state.owner_scope===ownerScope&&menuEpoch===epoch))dispatch(command);}});
  return [
  {id:'menu-jot',label:'Jot',submenu:[...(platform==='darwin'?[helpItem('about',text('关于 Jot','About Jot')),{type:'separator'}]:[]),{label:text('显示 Jot','Show Jot'),click:restoreWindow},{label:text('任务通知设置','Task Notification Settings'),click:openNotificationSettings},action('settings',text('设置…','Settings…'),'CmdOrCtrl+,'),action('check-updates',text('检查更新…','Check for Updates…')),...(platform==='darwin'?[{type:'separator'},{role:'services',label:text('服务','Services')},{type:'separator'},{role:'hide',label:text('隐藏 Jot','Hide Jot')},{role:'hideOthers',label:text('隐藏其他','Hide Others')},{role:'unhide',label:text('显示全部','Show All')}]:[]),{type:'separator'},{label:text('退出','Quit Jot'),click:requestQuit}]},
  {id:'menu-file',label:text('文件','File'),submenu:[action('new-conversation',text('新建对话…','New Conversation…'),'CmdOrCtrl+N'),action('new-project',text('新建项目…','New Project…'),'CmdOrCtrl+Shift+N'),{type:'separator'},{role:'close',label:text('关闭窗口','Close Window')}]},
  {id:'menu-edit',label:text('编辑','Edit'),submenu:[{role:'undo',label:text('撤销','Undo')},{role:'redo',label:text('重做','Redo')},{type:'separator'},{role:'cut',label:text('剪切','Cut')},{role:'copy',label:text('复制','Copy')},{role:'paste',label:text('粘贴','Paste')},{role:'selectAll',label:text('全选','Select All')},
   {...action('find',text('查找…','Find…'),'CmdOrCtrl+F'),registerAccelerator:false}]},
  {id:'menu-view',label:text('查看','View'),submenu:[{...action('toggle-sidebar',text('显示工作台导航','Show Workbench Navigation'),'CmdOrCtrl+B'),type:'checkbox',checked:state.sidebar_visible,registerAccelerator:false},{type:'separator'},
   {role:'resetZoom',label:text('实际大小','Actual Size')},{role:'zoomIn',label:text('放大','Zoom In')},{role:'zoomOut',label:text('缩小','Zoom Out')},{role:'togglefullscreen',label:text('切换全屏','Toggle Full Screen')}]},
  {id:'menu-go',label:text('前往','Go'),submenu:[action('chat',text('我的对话','Conversations')),action('files',text('共同文件','Shared Files')),action('skills',text('当前会话技能','Conversation Skills')),action('scheduled-tasks',text('持续任务','Persistent Tasks'))]},
  {id:'menu-help',label:text('帮助','Help'),role:'help',submenu:[helpItem('docs',text('使用文档','Documentation')),helpItem('issues',text('反馈问题／功能建议…','Report an Issue / Suggest a Feature…')),{type:'separator'},helpItem('logs',text('打开宿主日志文件','Open Host Log File')),helpItem('log-directory',text('打开日志目录','Open Log Directory')),helpItem('version',text('复制版本信息','Copy Version Information')),...(platform!=='darwin'?[{type:'separator'},helpItem('about',text('关于 Jot','About Jot'))]:[])]},
  ...(platform==='darwin'?[{role:'windowMenu',label:text('窗口','Window'),submenu:[{role:'minimize',label:text('最小化','Minimize')},{role:'zoom',label:text('缩放','Zoom')},{type:'separator'},{role:'front',label:text('全部置于前面','Bring All to Front')}]}]:[]),
 ];
 };
 let menu=Menu.buildFromTemplate(template()),menuLanguage=language();
 const setState=value=>{
  const next=parseDesktopMenuState(value);
  if(next.owner_scope!==state.owner_scope||!next.ready||next.blocked)menuEpoch+=1;
  state=next;
  for(const command of desktopMenuCommands){const item=menu.getMenuItemById('jot:'+command);if(item){item.enabled=desktopMenuCommandEnabled(command,state);if(command==='toggle-sidebar')item.checked=state.sidebar_visible;}}
 };
 const refresh=()=>{
  const next=language();if(next===menuLanguage)return false;menuEpoch++;
  const updated=Menu.buildFromTemplate(template());Menu.setApplicationMenu(updated);menu=updated;menuLanguage=next;return true;
 };
 Menu.setApplicationMenu(menu);
 return {refresh,setState,reset:()=>setState(emptyDesktopMenuState),template,getState:()=>state,getEpoch:()=>menuEpoch};
}
