// Caption geometry adapts PilotDeck 783499ff WindowsCaptionMenu; AGPL-3.0.
export const captionMenuIds=Object.freeze(['menu-jot','menu-file','menu-edit','menu-view','menu-go','menu-help']);
const known=value=>typeof value==='string'&&captionMenuIds.includes(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
export function parseCaptionMenuRequest(value){
 if(value===undefined)return Object.freeze({id:null,buttons:Object.freeze([])});
 if(!record(value)||!keys(value,['id','buttons'])||(value.id!==undefined&&value.id!==null&&!known(value.id))||
  (value.buttons!==undefined&&(!Array.isArray(value.buttons)||value.buttons.length>captionMenuIds.length)))throw Error('desktop_caption_request_invalid');
 const seen=new Set(),buttons=[];
 for(const button of value.buttons??[]){
  if(!record(button)||!keys(button,['id','x','y','width','height'])||!known(button.id)||seen.has(button.id)||
   !['x','y','width','height'].every(key=>Number.isFinite(button[key])&&button[key]>=0&&button[key]<=32768)||button.width<=0||button.height<=0)throw Error('desktop_caption_request_invalid');
  seen.add(button.id);buttons.push(Object.freeze({id:button.id,x:button.x,y:button.y,width:button.width,height:button.height}));
 }
 return Object.freeze({id:value.id??null,buttons:Object.freeze(buttons)});
}

export function parseCaptionProjectionCommand(kind,value){
 if(!['items','activate','dismiss'].includes(kind))throw Error('desktop_caption_request_invalid');
 const allowed=kind==='items'?['id']:kind==='activate'?['token','index']:['token'];
 if(!record(value)||Object.keys(value).sort().join(',')!==allowed.sort().join(','))throw Error('desktop_caption_request_invalid');
 if(kind==='items'){if(!known(value.id))throw Error('desktop_caption_request_invalid');return Object.freeze({id:value.id});}
 if(typeof value.token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token)||
  kind==='activate'&&(!Number.isSafeInteger(value.index)||value.index<0||value.index>=64))throw Error('desktop_caption_request_invalid');
 return Object.freeze(kind==='activate'?{token:value.token.toLowerCase(),index:value.index}:{token:value.token.toLowerCase()});
}
