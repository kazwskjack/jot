const {contextBridge,ipcRenderer}=require('electron');
(()=>{
if(process.isMainFrame!==true)return;

const validIdentity=value=>value&&typeof value.task_id==='string'&&value.task_id.length>0&&value.task_id.length<=200&&
 typeof value.occurrence_id==='string'&&value.occurrence_id.length>0&&value.occurrence_id.length<=200;
let openTaskListeners=new Set(),queuedOpenTasks=[],openNotificationSettingsListeners=new Set(),queuedOpenNotificationSettings=false;
const updateOperationIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const updatePhases=new Set(['available','downloading','downloaded','verified','staged','awaiting-activation','activating','active','cancelled','failed','unknown']);
const updateProgressListeners=new Set(),menuRefreshListeners=new Set();
ipcRenderer.on('desktop:menu-refresh',()=>{for(const listener of menuRefreshListeners)try{listener();}catch{}});
const notificationPermissionStatuses=new Set(['granted','denied','default','unsupported','unknown']);
const notificationPermissionListeners=new Set();
ipcRenderer.on('desktop:notification-permission',(_event,status)=>{
 if(!notificationPermissionStatuses.has(status))return;
 for(const listener of notificationPermissionListeners)try{listener(status);}catch{}
});
ipcRenderer.on('desktop:open-task',(_event,identity)=>{
 if(!validIdentity(identity))return;
 const safe=Object.freeze({task_id:identity.task_id,occurrence_id:identity.occurrence_id});
 if(!openTaskListeners.size){queuedOpenTasks.push(safe);if(queuedOpenTasks.length>8)queuedOpenTasks.shift();return;}
 for(const listener of openTaskListeners)try{listener(safe);}catch{}
});
ipcRenderer.on('desktop:open-notification-settings',()=>{
 if(!openNotificationSettingsListeners.size){queuedOpenNotificationSettings=true;return;}
 for(const listener of openNotificationSettingsListeners)try{listener();}catch{}
});
ipcRenderer.on('desktop:update-progress',(_event,value)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||
  typeof value.operation_id!=='string'||!updateOperationIdPattern.test(value.operation_id)||!updatePhases.has(value.phase))return;
 const safe=Object.freeze({operation_id:value.operation_id.toLowerCase(),phase:value.phase});
 for(const listener of updateProgressListeners)try{listener(safe);}catch{}
});
const menuCommands=new Set(['new-conversation','new-project','settings','check-updates','find','toggle-sidebar','chat','files','skills','scheduled-tasks']);
const commandListeners=new Set();
// Transient UI commands are never replayed into a later document/account.
ipcRenderer.on('desktop:command',(_event,value)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='command,owner_scope,protocol'
  ||value.protocol!==1||!menuCommands.has(value.command)||typeof value.owner_scope!=='string'||!/^[a-f0-9]{64}$/.test(value.owner_scope))return;
 const safe=Object.freeze({protocol:1,command:value.command,owner_scope:value.owner_scope});
 for(const listener of commandListeners)try{listener(safe);}catch{}
});
const captionMenuIds=new Set(['menu-jot','menu-file','menu-edit','menu-view','menu-go','menu-help','all']);
const captionMenuListeners=new Set();
ipcRenderer.on('desktop:caption-menu',(_event,value)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='id,protocol'||value.protocol!==1||(value.id!==null&&!captionMenuIds.has(value.id)))return;
 const safe=Object.freeze({protocol:1,id:value.id});
 for(const listener of captionMenuListeners)try{listener(safe);}catch{}
});
const linuxCaptionListeners=new Set();
ipcRenderer.on('desktop:linux-caption-update',(_event,value)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='generation,protocol,reset'||value.protocol!==1||!Number.isSafeInteger(value.generation)||value.generation<1||typeof value.reset!=='boolean')return;
 const safe=Object.freeze({protocol:1,generation:value.generation,reset:value.reset});for(const listener of linuxCaptionListeners)try{listener(safe);}catch{}
});
function linuxCaptionProjection(value,id){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='entries,generation,menu_id,protocol,token'||value.protocol!==1||value.menu_id!==id||
  !Number.isSafeInteger(value.generation)||value.generation<1||typeof value.token!=='string'||!updateOperationIdPattern.test(value.token)||!Array.isArray(value.entries)||value.entries.length>64)throw Error('desktop_caption_projection_invalid');
 const seen=new Set(),entries=value.entries.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['index','label','type','enabled','checked','accelerator'].includes(key))||
   !Number.isSafeInteger(item.index)||item.index<0||item.index>=64||seen.has(item.index)||typeof item.label!=='string'||item.label.length>512||/[\x00-\x1f\x7f]/.test(item.label)||
   !['normal','separator','checkbox'].includes(item.type)||typeof item.enabled!=='boolean'||typeof item.checked!=='boolean'||item.type==='separator'&&item.enabled||
   item.accelerator!==undefined&&(typeof item.accelerator!=='string'||item.accelerator.length>64||/[\x00-\x1f\x7f]/.test(item.accelerator)))throw Error('desktop_caption_projection_invalid');
  seen.add(item.index);return Object.freeze({index:item.index,label:item.label,type:item.type,enabled:item.enabled,checked:item.checked,accelerator:item.accelerator??''});
 });return Object.freeze({protocol:1,generation:value.generation,token:value.token,menu_id:id,entries:Object.freeze(entries)});
}
const chromePalette=theme=>theme==='light'?{background:'#faf9f6',caption:'#f0eee9',symbol:'#242731'}:{background:'#101217',caption:'#171a21',symbol:'#eef0f5'};
const windowChromeListeners=new Set();
function windowChromeState(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='caption_height,fullscreen,menus,palette,platform,protocol,revision,theme'||(value.protocol!==1&&value.protocol!==2)||!Number.isSafeInteger(value.revision)||value.revision<1||
  value.platform!==process.platform||!['win32','linux','darwin'].includes(value.platform)||typeof value.fullscreen!=='boolean'||!['dark','light'].includes(value.theme)||
  value.caption_height!==(value.platform==='darwin'?48:32)||!Array.isArray(value.menus)||value.menus.length>6||new Set(value.menus).size!==value.menus.length||value.menus.some(id=>id==='all'||!captionMenuIds.has(id)))return null;
 const standard=chromePalette(value.theme);
 if(!value.palette||typeof value.palette!=='object'||Array.isArray(value.palette)||Object.keys(value.palette).sort().join(',')!=='background,caption,symbol'||Object.values(value.palette).some(color=>typeof color!=='string'||!/^#[a-f0-9]{6}$/.test(color))||
  (value.protocol===1||value.theme==='dark')&&Object.keys(standard).some(key=>value.palette[key]!==standard[key]))return null;
 const palette={background:value.palette.background,caption:value.palette.caption,symbol:value.palette.symbol};
 return Object.freeze({protocol:value.protocol,revision:value.revision,platform:value.platform,theme:value.theme,fullscreen:value.fullscreen,caption_height:value.caption_height,palette:Object.freeze(palette),menus:Object.freeze([...value.menus])});
}
ipcRenderer.on('desktop:window-chrome',(_event,value)=>{const state=windowChromeState(value);if(state)for(const listener of windowChromeListeners)try{listener(state);}catch{}});
const invoke=(channel,payload)=>ipcRenderer.invoke(channel,payload);
const bridge=Object.freeze({
 platform:process.platform,
 onMenuRefresh(listener){if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');menuRefreshListeners.add(listener);return()=>menuRefreshListeners.delete(listener);},
 getAppearance:()=>ipcRenderer.sendSync('appearance.read'),
 getAppearanceCapabilities:()=>invoke('appearance.capabilities'),
 setAppearance:value=>invoke('appearance.write',value),
 saveAppearanceImage:bytes=>invoke('appearance.image.save',bytes),
 readAppearanceImage:id=>invoke('appearance.image.read',{id}),
 deleteAppearanceImage:id=>invoke('appearance.image.delete',{id}),
 recoverAppearanceImages:()=>invoke('appearance.image.recover'),
 getDesktopAbout:()=>invoke('desktop.about.read'),
 getWindowChrome:()=>invoke('window.chrome.read'),
 setWindowTheme:theme=>invoke('window.chrome.theme',{theme}),
 showCaptionMenu:value=>invoke('menu.caption.show',value),
 closeCaptionMenu:()=>invoke('menu.caption.close'),
 onCaptionMenu(listener){if(typeof listener!=='function')throw TypeError('desktop_listener_invalid');captionMenuListeners.add(listener);return()=>captionMenuListeners.delete(listener);},
 setMenuState:value=>invoke('menu.state.set',value),
 onCommand(listener){if(typeof listener!=='function')throw TypeError('desktop_listener_invalid');commandListeners.add(listener);return()=>commandListeners.delete(listener);},
 selectFile:()=>invoke('dialog.selectFile'),
 readNotificationState:()=>invoke('notification.state.read'),
 initializeNotificationState:startedAt=>invoke('notification.state.initialize',{started_at:startedAt}),
 readNotificationPermission:()=>invoke('notification.permission.read'),
 onNotificationPermission(listener){
  if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');
  notificationPermissionListeners.add(listener);
  return ()=>notificationPermissionListeners.delete(listener);
 },
 readNotificationPreferences:()=>invoke('preferences.read'),
 setNotificationPreferences:value=>invoke('preferences.write',value),
 showTaskNotification:(candidate,taskSettings)=>invoke('notification.show',{candidate,task_settings:taskSettings}),
 dismissTaskNotification:identity=>invoke('notification.dismiss',identity),
 getUpdateStatus:()=>invoke('update.status'),
 checkForUpdate:()=>invoke('update.check'),
 downloadUpdate:operationId=>operationId===undefined?invoke('update.download'):invoke('update.download',{operation_id:operationId}),
 pauseUpdate:operationId=>invoke('update.pause',{operation_id:operationId}),
 resumeUpdate:operationId=>invoke('update.resume',{operation_id:operationId}),
 cancelUpdate:operationId=>invoke('update.cancel',{operation_id:operationId}),
 activateUpdate:operationId=>invoke('update.activate',{operation_id:operationId}),
 onUpdateProgress(listener){
  if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');
  updateProgressListeners.add(listener);
  return ()=>updateProgressListeners.delete(listener);
 },
 onOpenTask(listener){
  if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');
  openTaskListeners.add(listener);
  for(const identity of queuedOpenTasks.splice(0))try{listener(identity);}catch{}
  return ()=>openTaskListeners.delete(listener);
 },
 onOpenNotificationSettings(listener){
  if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');
  openNotificationSettingsListeners.add(listener);
  if(queuedOpenNotificationSettings){queuedOpenNotificationSettings=false;try{listener();}catch{}}
  return ()=>openNotificationSettingsListeners.delete(listener);
 }
});
// Desktop-owned caption adapts PilotDeck 783499ff preloadChrome; AGPL-3.0.
function installWindowChrome(){
 const platform=process.platform;if(!['win32','linux','darwin'].includes(platform))return;
 const install=()=>{
  const root=document.documentElement;if(!root||!document.body||document.getElementById('jot-window-caption'))return;
  let disposed=false,serial=0,active=null,savedFocus=null,fullscreen=false,lastRevision=0,nativePalette=null;
  let desiredTheme=root.dataset.theme==='light'?'light':'dark';
  const systemTheme=window.matchMedia?.('(prefers-color-scheme: dark)');
  if(!root.hasAttribute('data-theme')){
   let mode='system';
   try{
    const raw=localStorage.getItem('jot-theme-preference-v1'),legacy=localStorage.getItem('jot-theme');
    if(legacy==='dark'||legacy==='light'||legacy==='system')mode=legacy;
    if(raw&&raw.length<=128){try{const value=JSON.parse(raw);
     if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='mode,version'&&value.version===1&&['system','dark','light'].includes(value.mode))mode=value.mode;
    }catch{}}
   }catch{}
   try{const saved=bridge.getAppearance();
    if([1,2,3].includes(saved?.protocol)&&saved.stored===true&&['system','light','dark'].includes(saved.themeMode)){
     if(saved.protocol===3&&(saved.language==='en'||saved.language==='zh-CN'))root.lang=saved.language;
     mode=saved.themeMode;const light=saved.lightAppearance;
     if(light?.version===2&&light.background&&typeof light.background==='object'&&!Array.isArray(light.background)){
      const raw=JSON.stringify({...light,background:{...light.background,imageId:null}});if(raw.length<=4096)root.dataset.jotWindowAppearance=raw;
     }
    }
   }catch{}
   root.dataset.themeMode=mode;desiredTheme=mode==='system'?(systemTheme?.matches?'dark':'light'):mode;root.dataset.theme=desiredTheme;
  }
  const followSystem=()=>{if(!disposed&&root.dataset.themeMode==='system')root.dataset.theme=systemTheme?.matches?'dark':'light';};
  systemTheme?.addEventListener('change',followSystem);
  const host=document.createElement('div');host.id='jot-window-caption';
  const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');
  style.textContent=`:host{position:fixed;top:0;left:0;height:var(--jot-caption-height);width:100%;z-index:10000;display:block;background:var(--jot-caption-bg);color:var(--jot-caption-fg);-webkit-app-region:drag;user-select:none;font:13px system-ui}
   :host([data-platform=darwin][data-toolbar]){width:100px;background:transparent}:host([data-platform=darwin][data-toolbar]) nav{display:none}
   :host([hidden]){display:none}:host([data-platform=win32]),:host([data-platform=linux]){left:env(titlebar-area-x,0px);width:env(titlebar-area-width,calc(100% - 150px))}
   nav{display:flex;align-items:center;height:100%;padding:0 8px;gap:2px;white-space:nowrap}button{-webkit-app-region:no-drag;padding:0 10px;height:calc(100% - 8px);max-height:32px;border:0;border-radius:5px;color:inherit;background:transparent;font:inherit;cursor:default}
   button:hover,button[aria-expanded=true]{background:color-mix(in srgb,currentColor 10%,transparent)}button:focus-visible{outline:2px solid #818cf8;outline-offset:-2px}button[hidden]{display:none}span{padding-left:96px}p{position:absolute;top:100%;margin:0;padding:8px;background:var(--jot-caption-bg);color:var(--jot-caption-fg);-webkit-app-region:no-drag}`;
  const sheet=document.createElement('style');sheet.textContent=`html[data-jot-desktop-platform]{--jot-caption-height:${platform==='darwin'?48:32}px;scroll-padding-top:var(--jot-caption-height)}
   html[data-jot-desktop-platform=win32],html[data-jot-desktop-platform=linux]{--jot-caption-height:env(titlebar-area-height,32px)}
   html[data-jot-desktop-platform=darwin][data-jot-desktop-toolbar] body{margin-top:0!important}
   html[data-jot-desktop-fullscreen]{--jot-caption-height:0px}html[data-jot-desktop-platform] body{margin-top:var(--jot-caption-height)!important;background:var(--jot-window-bg);color:var(--jot-caption-fg)}`;
  host.dataset.platform=platform;root.dataset.jotDesktopPlatform=platform;
  const nav=document.createElement('nav'),notice=document.createElement('p');notice.hidden=true;notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const definitions=[['menu-jot','Jot','Jot','a'],['menu-file','文件','File','f'],['menu-edit','编辑','Edit','e'],['menu-view','查看','View','v'],['menu-go','前往','Go','g'],['menu-help','帮助','Help','h']];
  const buttons=definitions.map(([id])=>{const button=document.createElement('button');button.type='button';button.dataset.menu=id;button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');button.hidden=id==='menu-help';nav.append(button);return button;});
  if(platform==='darwin'){const label=document.createElement('span');label.textContent='Jot';nav.replaceChildren(label);}else nav.setAttribute('role','menubar');
  shadow.append(style,nav,notice);document.head.append(sheet);document.body.append(host);
  const paint=()=>{
   host.toggleAttribute('data-toolbar',platform==='darwin'&&root.hasAttribute('data-jot-desktop-toolbar'));
   host.toggleAttribute('data-integrated',platform==='darwin'&&root.hasAttribute('data-jot-desktop-integrated'));
   let palette=!root.hasAttribute('data-jot-theme-ready')&&nativePalette?.theme===desiredTheme?nativePalette.palette:chromePalette(desiredTheme);
   if(desiredTheme==='light'&&root.hasAttribute('data-jot-light-appearance')){
    const css=getComputedStyle(root),custom={background:css.getPropertyValue('--jot-light-canvas').trim(),caption:css.getPropertyValue('--jot-light-sidebar').trim(),symbol:css.getPropertyValue('--jot-light-sidebar-ink').trim()};
    if(Object.values(custom).every(color=>/^#[a-f0-9]{6}$/.test(color)))palette=custom;
   }
   root.style.setProperty('--jot-window-bg',palette.background);root.style.setProperty('--jot-caption-bg',palette.caption);root.style.setProperty('--jot-caption-fg',palette.symbol);
   const zh=!root.lang||root.lang.toLowerCase().startsWith('zh');nav.setAttribute('aria-label',zh?'应用菜单':'Application menu');
   buttons.forEach((button,index)=>{button.textContent=definitions[index][zh?1:2];button.title=`${button.textContent} (Alt+${definitions[index][3].toUpperCase()})`;});
  };
  const restoreFocus=()=>{if(disposed){savedFocus=null;return;}const node=savedFocus;savedFocus=null;if((document.activeElement===host||document.activeElement===linuxHost)&&node instanceof HTMLElement&&node.isConnected&&node.getClientRects().length&&!node.closest('[hidden],[inert],[aria-hidden=true]'))node.focus({preventScroll:true});};
  const setActive=id=>{active=id;buttons.forEach(button=>button.setAttribute('aria-expanded',String(button.dataset.menu===id)));if(id===null)restoreFocus();};
  const captionEvent=value=>{if(!disposed)setActive(value.id);};captionMenuListeners.add(captionEvent);
  const applyState=value=>{
   const state=windowChromeState(value);if(disposed||!state||state.revision<lastRevision)return;lastRevision=state.revision;
   if(!root.hasAttribute('data-jot-theme-ready'))nativePalette={theme:state.theme,palette:state.palette};
   fullscreen=state.fullscreen;root.toggleAttribute('data-jot-desktop-fullscreen',fullscreen);host.hidden=fullscreen;
   for(const button of buttons)button.hidden=!state.menus.includes(button.dataset.menu);
   // Theme belongs to the page preference. A late native reply cannot replace it.
   paint();if(fullscreen){if(platform==='linux')closeLinux();else setActive(null);}
  };windowChromeListeners.add(applyState);
  const linuxHost=platform==='linux'?document.createElement('div'):null;
  let linuxShadow=null,popup=null,projection=null,linuxSerial=0,linuxGeneration=0;
  if(linuxHost){
   linuxHost.id='jot-linux-caption-popup';linuxHost.hidden=true;linuxShadow=linuxHost.attachShadow({mode:'closed'});
   const css=document.createElement('style');css.textContent=`:host{position:fixed;inset:0;z-index:10001;pointer-events:none;font:13px system-ui;color:var(--jot-caption-fg);-webkit-app-region:no-drag}:host([hidden]){display:none}
    .panel{position:fixed;box-sizing:border-box;min-width:250px;max-width:min(420px,calc(100vw - 16px));max-height:calc(100vh - 48px);overflow:auto;overscroll-behavior:contain;padding:6px;border-radius:9px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);background:var(--jot-caption-bg);box-shadow:0 12px 28px #0005;pointer-events:auto}
    button{display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;min-height:30px;padding:4px 10px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:default}button:hover:not(:disabled),button:focus-visible{background:color-mix(in srgb,currentColor 10%,transparent);outline:2px solid #818cf8;outline-offset:-2px}button:disabled{opacity:.48}.check{width:14px;flex:none}.label{flex:1}.shortcut{opacity:.7}.separator{height:1px;margin:6px 0;background:color-mix(in srgb,currentColor 20%,transparent)}`;
   popup=document.createElement('div');popup.className='panel';popup.setAttribute('role','menu');linuxShadow.append(css,popup);document.body.append(linuxHost);
  }
  const closeLinux=(release=true,focusCaption=false)=>{
   if(!linuxHost)return;linuxSerial+=1;const session=projection,id=active;projection=null;linuxHost.hidden=true;popup.replaceChildren();setActive(null);
   if(focusCaption&&!fullscreen)buttons.find(button=>button.dataset.menu===id)?.focus({preventScroll:true});
   if(release&&session)void invoke('menu.caption.dismiss',{token:session.token}).catch(()=>{});
  };
  const openLinux=async(button,keyboard=false)=>{
   if(!linuxHost||disposed||!button||button.hidden)return;
   if(!active&&!savedFocus)savedFocus=document.activeElement;
   const id=button.dataset.menu,request=++linuxSerial;setActive(id);notice.hidden=true;
   try{
    const state=linuxCaptionProjection(await invoke('menu.caption.items',{id}),id);
    if(disposed||request!==linuxSerial||state.generation<linuxGeneration){void invoke('menu.caption.dismiss',{token:state.token}).catch(()=>{});return;}
    linuxGeneration=state.generation;const focused=linuxShadow.activeElement?.dataset.index;projection=state;popup.replaceChildren();
    for(const entry of state.entries){
     const node=document.createElement(entry.type==='separator'?'div':'button');
     if(entry.type==='separator'){node.className='separator';node.setAttribute('role','separator');popup.append(node);continue;}
     node.type='button';node.dataset.index=String(entry.index);node.tabIndex=-1;node.disabled=!entry.enabled;
     node.setAttribute('role',entry.type==='checkbox'?'menuitemcheckbox':'menuitem');if(entry.type==='checkbox')node.setAttribute('aria-checked',String(entry.checked));
     for(const [name,text] of [['check',entry.checked?'✓':''],['label',entry.label],['shortcut',entry.accelerator]]){const span=document.createElement('span');span.className=name;span.textContent=text;node.append(span);}
     node.addEventListener('pointerdown',event=>event.preventDefault());
     node.addEventListener('click',()=>{
      if(disposed||projection!==state||!entry.enabled)return;closeLinux(false);
      void invoke('menu.caption.activate',{token:state.token,index:entry.index}).catch(()=>{if(!disposed){notice.textContent=(!root.lang||root.lang.startsWith('zh'))?'菜单已变化，请重新打开。':'Menu changed. Open it again.';notice.hidden=false;}});
     });popup.append(node);
    }
    popup.setAttribute('aria-label',button.textContent);linuxHost.hidden=false;
    const anchor=button.getBoundingClientRect();popup.style.top=`${fullscreen?8:Math.max(0,anchor.bottom)}px`;popup.style.left=`${Math.max(8,Math.min(anchor.left,innerWidth-popup.offsetWidth-8))}px`;
    if(keyboard||focused!==undefined)(Array.from(popup.querySelectorAll('button:not(:disabled)')).find(node=>node.dataset.index===focused)??popup.querySelector('button:not(:disabled)'))?.focus({preventScroll:true});
   }catch{if(!disposed&&request===linuxSerial){closeLinux();notice.textContent=(!root.lang||root.lang.startsWith('zh'))?'菜单暂不可用。':'Menu unavailable.';notice.hidden=false;}}
  };
  const linuxUpdate=value=>{if(!linuxHost||disposed||value.generation<linuxGeneration)return;linuxGeneration=value.generation;if(value.reset)closeLinux(false);else if(active)void openLinux(buttons.find(button=>button.dataset.menu===active),false);};
  const outsideLinux=event=>{if(linuxHost&&active&&event.target!==linuxHost&&event.target!==host)closeLinux();};
  const commandDismiss=()=>closeLinux();
  if(linuxHost){
   linuxCaptionListeners.add(linuxUpdate);commandListeners.add(commandDismiss);document.addEventListener('pointerdown',outsideLinux,true);window.addEventListener('blur',closeLinux);window.addEventListener('resize',closeLinux);
   popup.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||event.keyCode===229)return;
    if(event.key==='Tab'){closeLinux();return;}
    const visible=buttons.filter(button=>!button.hidden);
    if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const index=visible.findIndex(button=>button.dataset.menu===active);void openLinux(visible[(index+(event.key==='ArrowRight'?1:visible.length-1))%visible.length],true);return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();
    const entries=Array.from(popup.querySelectorAll('button:not(:disabled)'));if(!entries.length)return;const index=entries.indexOf(linuxShadow.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?entries.length-1:index<0?(event.key==='ArrowUp'?entries.length-1:0):(index+(event.key==='ArrowDown'?1:entries.length-1))%entries.length;entries[next].focus({preventScroll:true});
   });
  }

  const openMenu=async(button,keyboard=false)=>{
   if(disposed||button?.hidden)return;
   if(platform==='linux'){await openLinux(button??buttons.find(item=>!item.hidden),keyboard);return;}
   const id=button?.dataset.menu??null,target=id??'all';if(active===target)return;
   if(keyboard&&!savedFocus){savedFocus=document.activeElement;if(button&&!fullscreen)button.focus({preventScroll:true});}
   const request=++serial;notice.hidden=true;setActive(target);
   const geometry=fullscreen?[]:buttons.filter(item=>!item.hidden).map(item=>{const r=item.getBoundingClientRect();return {id:item.dataset.menu,x:r.x,y:r.y,width:r.width,height:r.height};});
   try{await invoke('menu.caption.show',{...(id?{id}:{}),buttons:geometry});}
   catch{if(!disposed&&request===serial){notice.textContent=(!root.lang||root.lang.startsWith('zh'))?'菜单暂不可用。':'Menu unavailable.';notice.hidden=false;}}
   finally{if(!disposed&&request===serial)setActive(null);}
  };
  buttons.forEach((button,index)=>{
   button.setAttribute('role','menuitem');button.tabIndex=index===0?0:-1;
   button.addEventListener('pointerdown',event=>event.preventDefault());
   button.addEventListener('click',()=>void openMenu(button));
   // GTK uses the short-lived template projection; native Windows hover stays in main.
   if(platform==='linux')button.addEventListener('mouseenter',()=>{if(active&&active!==button.dataset.menu)void openMenu(button);});
   button.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||event.keyCode===229)return;
    const visible=buttons.filter(item=>!item.hidden),position=visible.indexOf(button);
    if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
     event.preventDefault();const next=visible[(position+(event.key==='ArrowRight'?1:visible.length-1))%visible.length];
     for(const item of buttons)item.tabIndex=item===next?0:-1;next?.focus();if(active)void openMenu(next,true);
    }else if(event.key==='ArrowDown'){event.preventDefault();void openMenu(button,true);}
   });
  });
  const keydown=event=>{
   if(platform==='darwin'||event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey||event.isComposing||event.keyCode===229||event.getModifierState?.('AltGraph'))return;
   if(event.key==='Escape'&&active){event.preventDefault();if(platform==='linux')closeLinux(true,true);else void invoke('menu.caption.close').catch(()=>{});}
   else if(event.key==='F10'&&!event.altKey){event.preventDefault();void openMenu(undefined,true);}
   else if(event.altKey){const index=definitions.findIndex(item=>item[3]===event.key.toLowerCase());if(index>=0&&!buttons[index].hidden){event.preventDefault();void openMenu(buttons[index],true);}}
  };
  let sentAppearance=null;
  const syncTheme=()=>{
   if(disposed)return;desiredTheme=root.dataset.theme==='light'?'light':'dark';paint();
   const raw=desiredTheme==='light'?root.dataset.jotWindowAppearance:null;
   const appearance=typeof raw==='string'&&raw.length<=4096?raw:null,payload=appearance?{theme:desiredTheme,appearance}:{theme:desiredTheme},requested=JSON.stringify(payload);
   if(sentAppearance===requested)return;sentAppearance=requested;
   void invoke(appearance?'window.chrome.appearance':'window.chrome.theme',payload).then(applyState).catch(()=>{if(sentAppearance===requested)sentAppearance=null;});
  };
  const observer=new MutationObserver(syncTheme);observer.observe(root,{attributes:true,attributeFilter:['data-theme','data-theme-mode','data-jot-theme-ready','data-jot-window-appearance','lang','data-jot-desktop-toolbar','data-jot-desktop-integrated']});
  window.addEventListener('keydown',keydown);paint();
  void invoke('window.chrome.read').then(value=>{applyState(value);syncTheme();}).catch(syncTheme);
  const dispose=()=>{
   if(disposed)return;disposed=true;serial+=1;observer.disconnect();systemTheme?.removeEventListener('change',followSystem);window.removeEventListener('keydown',keydown);
   closeLinux();linuxCaptionListeners.delete(linuxUpdate);commandListeners.delete(commandDismiss);window.removeEventListener('blur',closeLinux);window.removeEventListener('resize',closeLinux);document.removeEventListener('pointerdown',outsideLinux,true);
   captionMenuListeners.delete(captionEvent);windowChromeListeners.delete(applyState);savedFocus=null;
   linuxHost?.remove();host.remove();sheet.remove();root.removeAttribute('data-jot-desktop-platform');root.removeAttribute('data-jot-desktop-fullscreen');
   root.style.removeProperty('--jot-caption-bg');root.style.removeProperty('--jot-caption-fg');root.style.removeProperty('--jot-window-bg');
  };window.addEventListener('pagehide',dispose,{once:true});

 };window.addEventListener('pageshow',event=>{if(event.persisted)install();});
 if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',install,{once:true});else install();
}

contextBridge.exposeInMainWorld('jotDesktop',bridge);
installWindowChrome();
})();
