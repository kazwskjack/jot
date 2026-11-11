// Adapts PilotDeck 783499ff appearance settings palette/color controls; AGPL-3.0.
import BackgroundAppearanceControls from './BackgroundAppearanceControls';
import React,{useEffect,useId,useState} from 'react';
import {LIGHT_PRESETS,isHexColor,normalizeLightAppearance,selectedPalette,type LightPalette,type LightPreset} from '../../packages/desktop/src/light-appearance.mjs';
import type {useLightAppearance} from './useLightAppearance';

function ColorControl({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>boolean}){
 const id=useId(),[draft,setDraft]=useState(value);useEffect(()=>setDraft(value),[value]);
 const invalid=!isHexColor(draft);
 return <div className="jot-appearance-color"><label htmlFor={id}>{label}</label><input type="color" aria-label={label} value={value} onChange={event=>{if(!onChange(event.target.value))setDraft(value);}}/><input id={id} type="text" aria-label={label+' HEX'} value={draft} maxLength={7} spellCheck={false} autoComplete="off" aria-invalid={invalid} onChange={event=>{setDraft(event.target.value);if(isHexColor(event.target.value)&&!onChange(event.target.value))setDraft(value);}} onBlur={()=>{if(invalid)setDraft(value);}}/></div>;
}
export default function LightAppearanceControls({light,dark,onLight,zh}:{light:ReturnType<typeof useLightAppearance>;dark:boolean;onLight:()=>void;zh:boolean}){
 const id=useId(),palette=selectedPalette(light.value);
 const labels:Record<LightPreset,string>=zh?{default:'默认',blue:'蓝色',mint:'薄荷',apricot:'杏色',lavender:'薰衣草',rose:'玫瑰',custom:'自定义'}:{default:'Default',blue:'Blue',mint:'Mint',apricot:'Apricot',lavender:'Lavender',rose:'Rose',custom:'Custom'};
 const color=(key:keyof LightPalette,value:string)=>light.update(current=>({...current,preset:'custom',custom:{...selectedPalette(current),[key]:value}}));
 return <section className="jot-appearance-panel" data-desktop-no-drag aria-labelledby={id}>
  <h3 id={id}>{zh?'浅色外观':'Light appearance'}</h3>
  {dark&&<p>{zh?'浅色配色在浅色主题下生效。':'Palettes apply to the light theme.'} <button type="button" disabled={light.unavailable} onClick={onLight}>{zh?'切换浅色':'Use light theme'}</button></p>}
  {light.saveFailed&&<p role="alert">{zh?'外观暂未保存，请重试。':'Appearance could not be saved. Please try again.'}</p>}
  <fieldset disabled={dark||light.unavailable||light.cleanupPending||light.recoveryPending}><legend>{zh?'配色':'Palette'}</legend><div className="jot-appearance-presets" role="group" aria-label={zh?'预设配色':'Palette presets'}>
   {(Object.keys(labels) as LightPreset[]).map(preset=>{const colors=preset==='custom'?light.value.custom:LIGHT_PRESETS[preset];return <button type="button" key={preset} aria-pressed={light.value.preset===preset} onClick={()=>light.update(current=>({...current,preset}))}><span className="jot-appearance-swatch" aria-hidden="true" style={{background:colors.background,borderColor:colors.accent}}/>{labels[preset]}</button>;})}
  </div><ColorControl label={zh?'强调色':'Accent'} value={palette.accent} onChange={value=>color('accent',value)}/><ColorControl label={zh?'背景颜色':'Background color'} value={palette.background} onChange={value=>color('background',value)}/>
  <button type="button" onClick={()=>light.update(current=>({...current,preset:'default',custom:normalizeLightAppearance().custom}))}>{zh?'重置配色':'Reset palette'}</button></fieldset>
  <BackgroundAppearanceControls light={light} dark={dark} zh={zh}/>
  <p className="jot-appearance-note">{zh?'外观保存在本机。自定义颜色会调整文字对比度，阅读区域保持明亮。':'Appearance is stored on this device. Text contrast adjusts to custom colors; reading areas remain light.'}</p>
 </section>;
}
