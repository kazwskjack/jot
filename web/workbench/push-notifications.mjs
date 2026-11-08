export function decodeVapidPublicKey(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{87}$/.test(value)||typeof atob!=='function'||typeof btoa!=='function')throw new Error('VAPID公钥格式无效');
 const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
 if(bytes.length!==65||bytes[0]!==4||btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')!==value)throw new Error('VAPID公钥格式无效');
 return bytes;
}

export function canOfferBrowserPushEnrollment({webPushBindingsEnabled,secureContext,notification,pushManager,serviceWorker}={}){
 return webPushBindingsEnabled===true&&secureContext===true&&typeof notification?.requestPermission==='function'&&!!pushManager&&typeof serviceWorker?.register==='function';
}

function assertScope(isCurrent){if(isCurrent&&!isCurrent())throw new Error('账户范围已变化，请切回原范围后重试。');}

function matchesApplicationServerKey(subscription,expected){
 let value;
 try{value=subscription?.options?.applicationServerKey;}catch{return false;}
 let bytes;
 try{bytes=ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):value&&Number.isSafeInteger(value.byteLength)?new Uint8Array(value):null;}catch{return false;}
 return !!bytes&&bytes.length===expected.length&&expected.every((byte,index)=>bytes[index]===byte);
}

export async function enableBrowserPush({api,notification,serviceWorker,idempotencyKey,isCurrent}){
 if(!notification||!serviceWorker?.register)throw new Error('当前浏览器不支持安全的浏览器通知');
 let permission=notification.permission;
 if(permission==='default')permission=await notification.requestPermission();
 if(permission!=='granted')throw new Error('请允许浏览器通知权限后重试');
 assertScope(isCurrent);
 const vapid=await api.getPushVapidPublicKey();
 assertScope(isCurrent);
 const registration=await serviceWorker.register('/workbench-notifications-sw.js',{scope:'/'});
 if(!registration?.pushManager)throw new Error('浏览器推送服务不可用');
 let subscription=await registration.pushManager.getSubscription();
 const applicationServerKey=decodeVapidPublicKey(vapid.public_key);
 if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey});
 else if(!matchesApplicationServerKey(subscription,applicationServerKey))throw new Error('浏览器订阅使用旧密钥或无法确认密钥。请先撤销此渠道，再重新启用。');
 assertScope(isCurrent);
 const data=subscription.toJSON?.(),endpoint=data?.endpoint??subscription.endpoint,keys=data?.keys;
 if(typeof endpoint!=='string'||typeof keys?.p256dh!=='string'||typeof keys?.auth!=='string')throw new Error('浏览器订阅数据无效');
 return api.registerPushSubscription({endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth}},idempotencyKey);
}

export async function revokeBrowserPush({api,serviceWorker,binding,idempotencyKey}){
 let subscription=null;
 try{const registration=await serviceWorker?.getRegistration?.('/');subscription=await registration?.pushManager?.getSubscription?.()??null;}catch{}
 const result=await api.revokePushSubscription(binding,idempotencyKey,typeof subscription?.endpoint==='string'?subscription.endpoint:undefined);
 const localSubscriptionMatches=result.local_subscription_matches===true;
 let localUnsubscribeFailed=false;
 if(localSubscriptionMatches){
  if(!subscription)localUnsubscribeFailed=true;
  else try{await subscription.unsubscribe();}catch{localUnsubscribeFailed=true;}
 }
 return {binding:result.binding,localSubscriptionMatches,localUnsubscribeFailed};
}
