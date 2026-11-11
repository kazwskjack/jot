// Adapts PilotDeck 783499ff appearance background/image/effect controls; AGPL-3.0.
import React,{useEffect,useId,useRef,useState} from 'react';
import {saveBackgroundImage} from './appearance-images';
import {normalizeLightAppearance,DEFAULT_TRANSPARENCY,MIN_TRANSPARENCY,MAX_TRANSPARENCY,type LightAppearance} from '../../packages/desktop/src/light-appearance.mjs';
import type {useLightAppearance} from './useLightAppearance';
function Slider({label,value,min=0,max,unit,onChange}:{label:string;value:number;min?:number;max:number;unit:string;onChange:(value:number)=>boolean}){
 const id=useId(),[draft,setDraft]=useState(String(value));useEffect(()=>setDraft(String(value)),[value]);
 return <div className="jot-appearance-slider"><label htmlFor={id}>{label}</label><input id={id} type="range" min={min} max={max} value={value} onChange={event=>{if(!onChange(Number(event.target.value)))setDraft(String(value));}}/><input type="number" aria-label={`${label} (${unit})`} min={min} max={max} value={draft} onChange={event=>{setDraft(event.target.value);if(event.target.value!==''&&event.target.validity.valid&&!onChange(Number(event.target.value)))setDraft(String(value));}} onBlur={()=>{const n=Number(draft);if(draft===''||!Number.isFinite(n))setDraft(String(value));else{const next=Math.round(Math.min(max,Math.max(min,n)));setDraft(String(next));if(!onChange(next))setDraft(String(value));}}}/><span aria-hidden="true">{unit}</span></div>;
}
export default function BackgroundAppearanceControls({light,dark,zh}:{light:ReturnType<typeof useLightAppearance>;dark:boolean;zh:boolean}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),input=useRef<HTMLInputElement>(null),alive=useRef(true),working=useRef(false),generation=useRef(0),context=useRef({dark,unavailable:light.unavailable});context.current={dark,unavailable:light.unavailable};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 const id=useId(),background=light.value.background,disabled=dark||light.unavailable||busy||light.cleanupPending;
 const message=(cause:unknown)=>{const text=cause instanceof Error?cause.message:'';return text.includes('_quota')?(zh?'本机图片存储已满，请先清理未使用的图片后重试。':'Image storage is full. Clean up unused images and try again.'):text==='appearance_image_dimensions'?(zh?'图片尺寸超出限制或无法读取，请选择较小的图片。':'Image dimensions exceed the limit or cannot be read. Choose a smaller image.'):text==='appearance_image_invalid'?(zh?'请选择不超过 10MiB 的 PNG、JPG 或 WebP 图片。':'Choose a PNG, JPG or WebP image under 10MiB.'):text==='appearance_image_save_unconfirmed'?(zh?'未能确认图片设置已保存，请重试。':'The image settings could not be confirmed as saved. Please try again.'):(zh?'本地图片暂时无法保存，请重试。':'The local image could not be saved. Please try again.');};
 const upload=async(file?:File)=>{
  if(!file||disabled||light.pending||working.current)return;working.current=true;setBusy(true);setError('');const ticket=++generation.current;
  const current=()=>alive.current&&generation.current===ticket&&!context.current.dark&&!context.current.unavailable;
  let asset:string|null=null,committed=false;
  try{asset=await saveBackgroundImage(file,current);if(!current())throw Error('appearance_image_cancelled');
   const imageId=asset;committed=await light.commit(value=>({...value,background:{...value.background,type:'image',imageId}}));if(!committed)throw Error('appearance_image_save_unconfirmed');
  }catch(cause){if(asset&&!committed)await light.discardImage(asset);if(current()&&!(cause instanceof Error&&cause.message==='appearance_image_cancelled'))setError(message(cause));}
  finally{working.current=false;if(alive.current&&generation.current===ticket){setBusy(false);if(input.current)input.current.value='';}}
 };
 const commit=async(update:(value:LightAppearance)=>LightAppearance)=>{
  if(disabled||light.pending||working.current)return;working.current=true;setBusy(true);setError('');const ticket=++generation.current;
  try{if(!await light.commit(update)&&alive.current&&generation.current===ticket)setError(message(Error('appearance_image_save_unconfirmed')));}
  catch(cause){if(alive.current&&generation.current===ticket)setError(message(cause));}
  finally{working.current=false;if(alive.current&&generation.current===ticket)setBusy(false);}
 };
 const change=(patch:Partial<LightAppearance['background']>)=>{setError('');return light.update(value=>({...value,background:{...value.background,...patch}}));};
 return <>
  {error&&<p role="alert">{error}</p>}
  <fieldset disabled={disabled}><legend>{zh?'背景':'Background'}</legend>
   <div className="jot-appearance-presets" role="group" aria-label={zh?'背景类型':'Background type'}>{(['solid','image'] as const).map(type=><button type="button" key={type} aria-pressed={background.type===type} onClick={()=>change({type})}>{type==='solid'?(zh?'纯色':'Solid'):(zh?'图片':'Image')}</button>)}</div>
   {background.type==='image'&&<>
    <div className="jot-appearance-image-upload" aria-busy={busy} onDragOver={event=>{if(!disabled&&!light.pending)event.preventDefault();}} onDrop={event=>{event.preventDefault();if(!disabled&&!light.pending)void upload(event.dataTransfer.files[0]);}}>
     {light.imageUrl&&<div className="jot-appearance-image-preview"><img src={light.imageUrl} alt={zh?'背景图片预览':'Background image preview'} onError={light.imageFailed}/></div>}
     <p>{zh?'选择或拖入本地图片；图片只保存在本机。':'Choose or drop a local image. Images stay on this device.'}</p>
     <p className="jot-appearance-note">{zh?'PNG、JPG 或 WebP，最多 10MiB；过大的图片需先缩小。':'PNG, JPG or WebP, up to 10MiB. Resize oversized images first.'}</p>
     <button type="button" disabled={!!light.pending} onClick={()=>input.current?.click()}>{busy?(zh?'正在保存…':'Saving…'):background.imageId?(zh?'替换图片':'Replace image'):(zh?'选择图片':'Choose image')}</button>
     {background.imageId&&<button type="button" disabled={!!light.pending} onClick={()=>void commit(value=>({...value,background:{...value.background,imageId:null}}))}>{zh?'移除图片':'Remove image'}</button>}
     <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden aria-label={zh?'选择背景图片':'Choose background image'} onChange={event=>void upload(event.target.files?.[0])}/>
    </div>
    {light.imageLoading&&<p role="status">{zh?'正在读取背景图…':'Loading background image…'}</p>}
    {light.imageMissing&&<p role="status">{zh?'背景图无法读取，已保留图片和效果设置，暂用纯色。':'The image could not be read. Its saved settings are retained; a solid background is shown.'} <button type="button" onClick={light.retryImage}>{zh?'重试读取':'Retry loading'}</button></p>}
    {!background.imageId&&<p>{zh?'尚未选择图片，当前使用纯色背景。':'No image is selected. A solid background is shown.'}</p>}
    {light.imageUrl&&<>
     <Slider label={zh?'透明度':'Transparency'} value={light.value.transparency} min={MIN_TRANSPARENCY} max={MAX_TRANSPARENCY} unit="%" onChange={transparency=>light.update(value=>({...value,transparency}))}/>
     <Slider label={zh?'模糊':'Blur'} value={background.blur} max={30} unit="px" onChange={blur=>change({blur})}/>
     <label htmlFor={id}>{zh?'图片填充':'Image fit'}</label><select id={id} value={background.fit} onChange={event=>{if(event.target.value==='cover'||event.target.value==='contain')change({fit:event.target.value});}}><option value="cover">{zh?'铺满':'Cover'}</option><option value="contain">{zh?'完整显示':'Contain'}</option></select>
     <details><summary>{zh?'图片调整':'Image adjustments'}</summary>
      <Slider label={zh?'亮度':'Brightness'} value={background.brightness} min={50} max={150} unit="%" onChange={brightness=>change({brightness})}/>
      <Slider label={zh?'饱和度':'Saturation'} value={background.saturation} max={150} unit="%" onChange={saturation=>change({saturation})}/>
      <Slider label={zh?'水平位置':'Horizontal position'} value={background.positionX} max={100} unit="%" onChange={positionX=>change({positionX})}/>
      <Slider label={zh?'垂直位置':'Vertical position'} value={background.positionY} max={100} unit="%" onChange={positionY=>change({positionY})}/>
      <button type="button" onClick={()=>light.update(value=>({...value,transparency:DEFAULT_TRANSPARENCY,background:{...value.background,fit:'cover',blur:0,brightness:100,saturation:100,positionX:50,positionY:50}}))}>{zh?'重置图片效果':'Reset image effects'}</button>
     </details>
    </>}
   </>}
  </fieldset>
  {light.cleanupFailed&&<p role="status">{zh?'部分旧图片尚未清理，文件已保留。':'Some unused images could not be cleaned up and were retained.'} <button type="button" disabled={busy||!!light.pending||light.cleanupPending} onClick={()=>void light.retryCleanup()}>{zh?'重试清理':'Retry cleanup'}</button></p>}
  <button type="button" disabled={disabled||!!light.pending} onClick={()=>void commit(()=>normalizeLightAppearance())}>{zh?'重置浅色外观':'Reset light appearance'}</button>
 </>;
}
