// Adapts PilotDeck 783499ff appearance startupText/rendererRecovery; AGPL-3.0.
export function desktopLanguage(app){
 try{return app.getLocale().toLowerCase().startsWith('zh')?'zh-CN':'en';}catch{return 'en';}
}
const messages=Object.freeze({
 startupLoading:['Starting the local Jot service…','正在启动 Jot 本地服务…'],
 startupOpening:['Opening the Jot interface…','正在打开 Jot 界面…'],
 startupStopping:['Stopping Jot and closing local resources…','正在停止 Jot 并关闭本地资源…'],
 startupLogUnavailable:['The desktop host log is not available yet.','桌面宿主日志暂不可用。'],
 startupActions:['Startup actions','启动操作'],
 retry:['Retry','重试'],
 openLog:['Open host log','打开宿主日志'],
 quit:['Quit Jot','退出 Jot'],
 startupTitle:['Jot could not start','无法启动 Jot 桌面版'],
 startupFailure:['Jot could not complete startup. Check the desktop host log and try again.','Jot 未能完成启动。请查看桌面宿主日志后重试。'],
 crashed:['The interface closed unexpectedly','界面意外关闭'],
 unresponsive:['The interface is not responding','界面暂时没有响应'],
 reloadDetail:['Reloading handles the interface without restarting background tasks. Only saved interface content can be restored.','重新加载只处理界面，不重启后台任务；只能恢复已保存的界面内容。'],
 reload:['Reload interface','重新加载界面'],
 later:['Not now','暂不处理'],
 wait:['Keep waiting','继续等待']
});
export function desktopText(key,language='en'){
 if(!Object.hasOwn(messages,key))throw Error('desktop_text_key_invalid');
 return messages[key][language==='zh-CN'?1:0];
}
