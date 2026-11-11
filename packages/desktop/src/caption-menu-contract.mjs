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
