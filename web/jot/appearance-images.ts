// Adapts PilotDeck 783499ff appearanceImages and uses Jot's shared image preflight; AGPL-3.0.
import {appearanceImageSize} from '../../packages/desktop/src/appearance-image.mjs';
import {LIGHT_APPEARANCE_KEY,LEGACY_LIGHT_APPEARANCE_KEY,MAX_BACKGROUND_BYTES,isImageId,normalizeLightAppearance,type LightAppearance} from '../../packages/desktop/src/light-appearance.mjs';
type Bridge={getAppearance?:()=>unknown;saveAppearanceImage?:(bytes:Uint8Array)=>Promise<unknown>;readAppearanceImage?:(id:string)=>Promise<unknown>;deleteAppearanceImage?:(id:string)=>Promise<unknown>;recoverAppearanceImages?:()=>Promise<unknown>};
const native=()=>{const bridge=(window as Window&{jotDesktop?:Bridge}).jotDesktop;return typeof bridge?.getAppearance==='function'?bridge:null;};
const imageProtocol='jot.appearance.image.v1',stageDuration=30*60*1000;
type ManagedImage={protocol:typeof imageProtocol;id:string;stage:null|{owner:string;expiresAt:number}};
let pageOwner:string|null=null;
const owner=()=>pageOwner??=(identifier().slice(0,-4));
const metadataKey=(id:string)=>'jot.metadata.'+id;
function managedImage(value:unknown,id:string):ManagedImage|null{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='id,protocol,stage')return null;
 const row=value as Record<string,unknown>;
 if(row.protocol!==imageProtocol||row.id!==id||!isImageId(row.id))return null;
 if(row.stage!==null){
  if(!row.stage||typeof row.stage!=='object'||Array.isArray(row.stage)||Object.keys(row.stage).sort().join(',')!=='expiresAt,owner')return null;
  const stage=row.stage as Record<string,unknown>;
  if(typeof stage.owner!=='string'||!isImageId(stage.owner+'.png')||!Number.isSafeInteger(stage.expiresAt)||Number(stage.expiresAt)<0)return null;
 }
 return value as ManagedImage;
}
const imageBlob=(value:unknown)=>value instanceof Blob?value:null;
export type ImageRecovery={protocol:1;removed:number;retained:number;scanned:number;complete:boolean};
function recoveryResult(value:unknown):ImageRecovery{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='complete,protocol,removed,retained,scanned')throw Error('appearance_image_reply_invalid');
 const row=value as Record<string,unknown>;
 if(row.protocol!==1||typeof row.complete!=='boolean'||['removed','retained','scanned'].some(key=>!Number.isSafeInteger(row[key])||Number(row[key])<0||Number(row[key])>128)||Number(row.removed)+Number(row.retained)>Number(row.scanned))throw Error('appearance_image_reply_invalid');
 return value as ImageRecovery;
}
const canceled=()=>Error('appearance_image_cancelled');
function database():Promise<IDBDatabase>{
 return new Promise((resolve,reject)=>{
  let rejected=false;const request=indexedDB.open('jot-appearance-images',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('images');
  request.onblocked=()=>{rejected=true;reject(Error('appearance_image_storage_blocked'));};
  request.onerror=()=>reject(Error('appearance_image_storage_failed'));
  request.onsuccess=()=>{const db=request.result;if(rejected){db.close();return;}db.onversionchange=()=>db.close();resolve(db);};
 });
}
async function transaction<T>(mode:IDBTransactionMode,operation:(store:IDBObjectStore,done:(value:T)=>void,fail:(cause:unknown)=>void)=>void):Promise<T>{
 const db=await database();
 return new Promise<T>((resolve,reject)=>{
  let tx:IDBTransaction,result:T,completed=false,cause:unknown;
  const finish=(success:boolean)=>{db.close();if(success&&completed)resolve(result);else reject(cause??Error('appearance_image_storage_failed'));};
  try{tx=db.transaction('images',mode);}catch(error){db.close();reject(error);return;}
  const fail=(error:unknown)=>{cause=error;try{tx.abort();}catch{finish(false);}};
  tx.oncomplete=()=>finish(true);tx.onabort=tx.onerror=()=>finish(false);
  const store=tx.objectStore('images'),barrier=store.get('__appearance_transaction_barrier__');
  barrier.onsuccess=()=>{try{operation(store,value=>{result=value;completed=true;},fail);}catch(error){fail(error);}};
 });
}
export function readBrowserLight():LightAppearance{
 const raw=localStorage.getItem(LIGHT_APPEARANCE_KEY)??localStorage.getItem(LEGACY_LIGHT_APPEARANCE_KEY);
 if(!raw)return normalizeLightAppearance();
 if(raw.length>4096)throw Error('appearance_settings_invalid');
 const value=JSON.parse(raw);
 if(!value||typeof value!=='object'||Array.isArray(value)||![undefined,1,2].includes(value.version))throw Error('appearance_settings_invalid');
 return normalizeLightAppearance(value);
}
type BrowserReceipt={value:LightAppearance;previousImageId:string|null};
export async function writeBrowserLight(update:(value:LightAppearance)=>LightAppearance,canCommit:()=>boolean):Promise<BrowserReceipt>{
 const saved:{receipt:BrowserReceipt|null}={receipt:null};
 const write=()=>{if(!canCommit())throw canceled();const before=readBrowserLight(),next=normalizeLightAppearance(update(before));localStorage.setItem(LIGHT_APPEARANCE_KEY,JSON.stringify(next));const receipt={value:next,previousImageId:before.background.imageId};saved.receipt=receipt;return receipt;};
 try{return await transaction<BrowserReceipt>('readwrite',(store,done,fail)=>{
  const before=readBrowserLight(),next=normalizeLightAppearance(update(before)),id=next.background.imageId;
  if(!id){done(write());return;}
  const request=store.get(id);request.onsuccess=()=>{try{
   const newReference=id!==before.background.imageId;
   if(newReference&&!imageBlob(request.result))throw Error('appearance_image_missing');
   const metadata=store.get(metadataKey(id));metadata.onsuccess=()=>{try{
    const row=managedImage(metadata.result,id);
    if(newReference&&metadata.result!==undefined&&!row)throw Error('appearance_image_storage_invalid');
    if(newReference&&row?.stage&&(row.stage.expiresAt<=Date.now()||row.stage.owner!==owner()))throw Error('appearance_image_stage_expired');
    if(row?.stage)store.put({...row,stage:null},metadataKey(id));done(write());
   }catch(error){fail(error);}};
  }catch(error){fail(error);}};
 });}
 catch(error){
  // localStorage can succeed even when the otherwise read-only barrier transaction aborts.
  const committed=saved.receipt;
  if(committed&&JSON.stringify(readBrowserLight())===JSON.stringify(committed.value))return committed;
  // Solid palettes and explicit reference removal remain usable without image storage; file cleanup can retry.
  if(!committed){const before=readBrowserLight(),next=normalizeLightAppearance(update(before));if(!next.background.imageId)return write();}
  throw error;
 }
}
function identifier(){
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID()+'.png';
 const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;
 const h=Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}.png`;
}
async function saveBrowserImage(blob:Blob,canCommit:()=>boolean):Promise<string>{
 const id=identifier();
 return transaction<string>('readwrite',(store,done,fail)=>{
  let count=0,total=0,scanned=0;const cursor=store.openCursor();
  cursor.onsuccess=()=>{try{
   const item=cursor.result;
   if(item){if(++scanned>128)throw Error('appearance_image_quota');if(isImageId(item.key)){const blob=imageBlob(item.value);if(!blob)throw Error('appearance_image_storage_invalid');count++;total+=blob.size;}item.continue();return;}
   if(count>=32||total+blob.size>160*1024*1024)throw Error('appearance_image_quota');
   if(!canCommit())throw canceled();store.add(blob,id);store.add({protocol:imageProtocol,id,stage:{owner:owner(),expiresAt:Date.now()+stageDuration}} satisfies ManagedImage,metadataKey(id));done(id);
  }catch(error){fail(error);}};
 });
}
export async function deleteBackgroundImage(id:string):Promise<boolean>{
 if(!isImageId(id))throw Error('appearance_image_invalid');
 const bridge=native();
 if(bridge){if(typeof bridge.deleteAppearanceImage!=='function')throw Error('appearance_image_unavailable');const result=await bridge.deleteAppearanceImage(id);if(typeof result!=='boolean')throw Error('appearance_image_reply_invalid');return result;}
 return transaction<boolean>('readwrite',(store,done,fail)=>{if(readBrowserLight().background.imageId===id){done(false);return;}
  const request=store.get(id);request.onsuccess=()=>{try{
   if(request.result!==undefined&&!imageBlob(request.result))throw Error('appearance_image_storage_invalid');
   const metadata=store.get(metadataKey(id));metadata.onsuccess=()=>{try{
    const row=managedImage(metadata.result,id);if(metadata.result!==undefined&&!row)throw Error('appearance_image_storage_invalid');
    if(row?.stage&&row.stage.owner!==owner()&&row.stage.expiresAt>Date.now()){done(false);return;}
    store.delete(id);if(row)store.delete(metadataKey(id));done(true);
   }catch(error){fail(error);}};
  }catch(error){fail(error);}};
 });
}
export async function loadBackgroundImage(id:string):Promise<string>{
 if(!isImageId(id))throw Error('appearance_image_invalid');const bridge=native();let blob:Blob;
 if(bridge){if(typeof bridge.readAppearanceImage!=='function')throw Error('appearance_image_unavailable');const bytes=await bridge.readAppearanceImage(id);
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_BACKGROUND_BYTES)throw Error('appearance_image_invalid');blob=new Blob([new Uint8Array(bytes)],{type:id.toLowerCase().endsWith('.png')?'image/png':'image/webp'});
 }else blob=await transaction<Blob>('readonly',(store,done,fail)=>{const request=store.get(id);request.onsuccess=()=>{const blob=imageBlob(request.result);if(blob)done(blob);else fail(Error('appearance_image_missing'));};});
 if(blob.size<=0||blob.size>MAX_BACKGROUND_BYTES)throw Error('appearance_image_invalid');
 const bytes=new Uint8Array(await blob.arrayBuffer()),mime=id.toLowerCase().endsWith('.png')?'image/png':'image/webp';
 if(!appearanceImageSize(bytes,mime,{stored:true}))throw Error('appearance_image_invalid');
 const bitmap=await createImageBitmap(blob);try{if(bitmap.width<=0||bitmap.height<=0||bitmap.width>3840||bitmap.height>3840)throw Error('appearance_image_invalid');}finally{bitmap.close();}
 return URL.createObjectURL(blob);
}

export async function prepareBackgroundImage(file:File,canContinue:()=>boolean):Promise<Blob>{
 if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size<=0||file.size>MAX_BACKGROUND_BYTES)throw Error('appearance_image_invalid');
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(!canContinue())throw canceled();
 if(!appearanceImageSize(bytes,file.type))throw Error('appearance_image_dimensions');
 const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas');
 try{
  if(!canContinue())throw canceled();
  const scale=Math.min(1,3840/Math.max(bitmap.width,bitmap.height));
  if(bitmap.width<=0||bitmap.height<=0||bitmap.width>32768||bitmap.height>32768||bitmap.width*bitmap.height>64*1024*1024)throw Error('appearance_image_dimensions');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d');if(!context)throw Error('appearance_image_encode_failed');
  for(let attempt=0;attempt<5;attempt++){
   if(!canContinue())throw canceled();context.drawImage(bitmap,0,0,canvas.width,canvas.height);
   const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));
   if(!blob||blob.type!=='image/png')throw Error('appearance_image_encode_failed');
   if(blob.size>0&&blob.size<=MAX_BACKGROUND_BYTES)return blob;
   canvas.width=Math.max(1,Math.round(canvas.width*.75));canvas.height=Math.max(1,Math.round(canvas.height*.75));
  }
  throw Error('appearance_image_encode_failed');
 }finally{bitmap.close();canvas.width=1;canvas.height=1;}
}
export async function saveBackgroundImage(file:File,canContinue:()=>boolean):Promise<string>{
 const blob=await prepareBackgroundImage(file,canContinue);if(!canContinue())throw canceled();
 const bridge=native();let id:string;
 if(bridge){if(typeof bridge.saveAppearanceImage!=='function')throw Error('appearance_image_unavailable');const result=await bridge.saveAppearanceImage(new Uint8Array(await blob.arrayBuffer()));
  if(!isImageId(result)||!result.endsWith('.png'))throw Error('appearance_image_reply_invalid');id=result;
 }else id=await saveBrowserImage(blob,canContinue);
 if(!canContinue()){await deleteBackgroundImage(id).catch(()=>{});throw canceled();}return id;
}

// Copy only this origin's legacy blob; its browser reference and original data stay intact.
export async function copyBrowserBackgroundImage(id:string,canContinue:()=>boolean):Promise<string|null>{
 if(!isImageId(id))throw Error('appearance_image_invalid');
 const bridge=native();if(!bridge||typeof bridge.saveAppearanceImage!=='function'||typeof bridge.readAppearanceImage!=='function')throw Error('appearance_image_unavailable');
 const source=await transaction<Blob|null>('readonly',(store,done,fail)=>{const request=store.get(id);request.onsuccess=()=>{
  if(request.result===undefined){done(null);return;}const blob=imageBlob(request.result);if(blob)done(blob);else fail(Error('appearance_image_storage_invalid'));
 };});
 if(!canContinue())throw canceled();if(!source)return null;
 if(source.size<=0||source.size>MAX_BACKGROUND_BYTES)throw Error('appearance_image_invalid');
 const mime=id.toLowerCase().endsWith('.png')?'image/png':'image/webp',bytes=new Uint8Array(await source.arrayBuffer());
 if(!canContinue())throw canceled();if(!appearanceImageSize(bytes,mime,{stored:true}))throw Error('appearance_image_invalid');
 const prepared=await prepareBackgroundImage(new File([bytes],id,{type:mime}),canContinue),encoded=new Uint8Array(await prepared.arrayBuffer());
 if(!canContinue())throw canceled();
 const result=await bridge.saveAppearanceImage(encoded);
 if(!isImageId(result)||!result.endsWith('.png'))throw Error('appearance_image_reply_invalid');
 try{
  if(!canContinue())throw canceled();const readback=await bridge.readAppearanceImage(result);
  if(!(readback instanceof Uint8Array)||readback.byteLength!==encoded.byteLength||!encoded.every((byte,index)=>byte===readback[index]))throw Error('appearance_image_reply_invalid');
  if(!canContinue())throw canceled();return result;
 }catch(error){await deleteBackgroundImage(result).catch(()=>{});throw error;}
}

export async function recoverBackgroundImages():Promise<ImageRecovery>{
 const bridge=native();
 if(bridge){if(typeof bridge.recoverAppearanceImages!=='function')throw Error('appearance_image_unavailable');return recoveryResult(await bridge.recoverAppearanceImages());}
 return transaction<ImageRecovery>('readwrite',(store,done,fail)=>{
  const reference=readBrowserLight().background.imageId,result:ImageRecovery={protocol:1,removed:0,retained:0,scanned:0,complete:true},cursor=store.openCursor();
  cursor.onsuccess=()=>{try{
   const item=cursor.result;if(!item){done(result);return;}if(result.scanned>=128){result.complete=false;done(result);return;}result.scanned++;
   if(isImageId(item.key)){
    const id=item.key,metadata=store.get(metadataKey(id));metadata.onsuccess=()=>{try{
     const row=managedImage(metadata.result,id),blob=imageBlob(item.value);
     if(id===reference||!row||!blob||blob.size<=0||blob.size>MAX_BACKGROUND_BYTES||row.stage&&row.stage.expiresAt>Date.now())result.retained++;
     else{item.delete();store.delete(metadataKey(id));result.removed++;}item.continue();
    }catch(error){fail(error);}};return;
   }
   if(typeof item.key==='string'&&item.key.startsWith('jot.metadata.')){
    const id=item.key.slice('jot.metadata.'.length),row=managedImage(item.value,id);
    if(row){const request=store.get(id);request.onsuccess=()=>{try{
     if(request.result===undefined){if(id===reference||row.stage&&row.stage.expiresAt>Date.now())result.retained++;else item.delete();}item.continue();
    }catch(error){fail(error);}};return;}
   }
   result.retained++;item.continue();
  }catch(error){fail(error);}};
 });
}
