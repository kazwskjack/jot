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
 const id=useId(),palette=selectedPalette(light.value),settings=light.interfaceSettings;
 const labels:Record<LightPreset,string>=zh?{default:'默认',blue:'蓝色',mint:'薄荷',apricot:'杏色',lavender:'薰衣草',rose:'玫瑰',custom:'自定义'}:{default:'Default',blue:'Blue',mint:'Mint',apricot:'Apricot',lavender:'Lavender',rose:'Rose',custom:'Custom'};
 const color=(key:keyof LightPalette,value:string)=>light.update(current=>({...current,preset:'custom',custom:{...selectedPalette(current),[key]:value}}));
 return <section className="jot-appearance-panel" data-desktop-no-drag aria-labelledby={id}>
  <h3 id={id}>{zh?'浅色外观':'Light appearance'}</h3>
  {dark&&<p>{zh?'浅色配色在浅色主题下生效。':'Palettes apply to the light theme.'} <button type="button" disabled={light.unavailable} onClick={onLight}>{zh?'切换浅色':'Use light theme'}</button></p>}
  {light.saveFailed&&<p role="alert">{zh?'外观暂未保存，请重试。':'Appearance could not be saved. Please try again.'} <button type="button" disabled={light.unavailable||!!light.pending||light.cleanupPending||light.recoveryPending} onClick={light.retrySave}>{zh?'重试保存':'Retry saving'}</button></p>}
  <fieldset disabled={dark||light.unavailable||light.cleanupPending||light.recoveryPending}><legend>{zh?'配色':'Palette'}</legend><div className="jot-appearance-presets" role="group" aria-label={zh?'预设配色':'Palette presets'}>
   {(Object.keys(labels) as LightPreset[]).map(preset=>{const colors=preset==='custom'?light.value.custom:LIGHT_PRESETS[preset];return <button type="button" key={preset} aria-pressed={light.value.preset===preset} onClick={()=>light.update(current=>({...current,preset}))}><span className="jot-appearance-swatch" aria-hidden="true" style={{background:colors.background,borderColor:colors.accent}}/>{labels[preset]}</button>;})}
  </div><ColorControl label={zh?'强调色':'Accent'} value={palette.accent} onChange={value=>color('accent',value)}/><ColorControl label={zh?'背景颜色':'Background color'} value={palette.background} onChange={value=>color('background',value)}/>
  <button type="button" onClick={()=>light.update(current=>({...current,preset:'default',custom:normalizeLightAppearance().custom}))}>{zh?'重置配色':'Reset palette'}</button></fieldset>
  <BackgroundAppearanceControls light={light} dark={dark} zh={zh}/>
  <fieldset disabled={light.unavailable||!settings.available||light.cleanupPending||light.recoveryPending}><legend>{zh?'界面运行设置':'Interface settings'}</legend>
   <label htmlFor={id+'-motion'}>{zh?'减少动画':'Reduced motion'}</label><select id={id+'-motion'} value={settings.value.reducedMotion} onChange={event=>{const reducedMotion=event.target.value;if(reducedMotion==='system'||reducedMotion==='on'||reducedMotion==='off')settings.update({reducedMotion});}}>
    <option value="system">{zh?'跟随系统':'System'}</option><option value="on">{zh?'开启':'On'}</option><option value="off">{zh?'关闭':'Off'}</option>
   </select>
   <p>{zh?'控制界面动画、过渡与平滑滚动。':'Controls interface animations, transitions and smooth scrolling.'}</p>
   <label><input type="checkbox" checked={settings.value.hardwareAcceleration} disabled={!settings.native||settings.hardwareActive===null} onChange={event=>settings.update({hardwareAcceleration:event.target.checked})}/>{zh?'硬件加速':'Hardware acceleration'}</label>
   <p>{settings.native?(zh?'保存后在下次启动生效。':'Saved changes apply on the next launch.'):(zh?'浏览器的硬件加速由浏览器自身设置管理。':'Hardware acceleration is managed by your browser settings.')}</p>
  </fieldset>
  {settings.capabilitiesFailed&&<p role="status">{zh?'无法确认本次启动的硬件加速设置。':'The hardware acceleration setting for this launch is unavailable.'} <button type="button" onClick={settings.retryCapabilities}>{zh?'重试读取':'Retry reading'}</button></p>}
  {settings.restartRequired&&<p role="status">{zh?'已保存的硬件加速设置将在退出并重新启动 Jot 后生效。':'The saved hardware acceleration setting takes effect after you quit and restart Jot.'}</p>}

  <p className="jot-appearance-note">{zh?'外观保存在本机。自定义颜色会调整文字对比度，阅读区域保持明亮。':'Appearance is stored on this device. Text contrast adjusts to custom colors; reading areas remain light.'}</p>
 </section>;
}
