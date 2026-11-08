import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';

export function createRendererNotificationClass({getWindow,idFactory=randomUUID}={}){
 if(typeof getWindow!=='function'||typeof idFactory!=='function')throw new Error('desktop_renderer_notification_invalid');
 const instances=new Map();
 class RendererNotification extends EventEmitter{
  static isSupported(){return true;}
  static handleRendererEvent(id,event){
   if(typeof id!=='string'||!['show','failed','click','close'].includes(event))return false;
   const notification=instances.get(id);if(!notification)return false;
   if(event==='failed'||event==='close')instances.delete(id);
   notification.emit(event);return true;
  }
  constructor(options={}){
   super();this.id=idFactory();this.options=options;this.closed=false;
   if(typeof this.id!=='string'||!this.id||this.id.length>100)throw new Error('desktop_renderer_notification_id_invalid');
   instances.set(this.id,this);
  }
  show(){
   if(this.closed)return;
   try{
    const window=getWindow();if(!window||window.isDestroyed?.()||window.webContents.isDestroyed?.())throw new Error('desktop_window_unavailable');
    window.webContents.send('desktop:notification-show',{id:this.id,title:this.options.title,body:this.options.body});
   }catch{RendererNotification.handleRendererEvent(this.id,'failed');}
  }
  close(){
   if(this.closed)return;this.closed=true;instances.delete(this.id);
   try{const window=getWindow();if(window&&!window.isDestroyed?.()&&!window.webContents.isDestroyed?.())window.webContents.send('desktop:notification-close',this.id);}catch{}
   this.emit('close');
  }
 }
 return RendererNotification;
}
