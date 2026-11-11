// Adapts PilotDeck 783499ff appearance startupText/rendererRecovery; AGPL-3.0.
export function desktopLanguage(app){
 try{return app.getLocale().toLowerCase().startsWith('zh')?'zh-CN':'en';}catch{return 'en';}
}
const messages=Object.freeze({
 startupTitle:['Jot could not start','无法启动 Jot 桌面版'],
 startupFailure:['Jot could not complete startup. Quit and try again. If this continues, check the desktop host log.','Jot 未能完成启动。请退出后重试；如果仍无法启动，请查看桌面宿主日志。'],
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
