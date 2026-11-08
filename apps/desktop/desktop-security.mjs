export function desktopWebPreferences(preload){
 if(typeof preload!=='string'||!preload)throw new Error('desktop_preload_path_invalid');
 return Object.freeze({preload,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false});
}

export function isDesktopAppUrl(value,appOrigin){
 try{
  const origin=new URL(appOrigin),target=new URL(value);
  return origin.protocol==='http:'&&origin.hostname==='127.0.0.1'&&!!origin.port&&!origin.username&&!origin.password&&origin.origin===appOrigin&&!target.username&&!target.password&&target.origin===appOrigin;
 }catch{return false;}
}

export function mayGrantNotificationPermission({permission,requestingUrl,appOrigin,mainFrame,deviceEnabled}={}){
 return permission==='notifications'&&mainFrame===true&&deviceEnabled===true&&isDesktopAppUrl(requestingUrl,appOrigin);
}
