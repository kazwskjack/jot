// About presentation adapts PilotDeck 783499ff desktopAbout/DesktopAboutSections; AGPL-3.0.
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {taskDraftScope} from '../jot/client';
type About={version:string|null;platform:string;arch:string;os_release:string|null;build_time:string|null;source_commit:string|null;launcher_release_id:string|null;versions:{electron:string|null;chrome:string|null;node:string|null};license:string;version_information:string};
const row=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f\x7f]/.test(value);
const optional=(value:unknown)=>value===null||text(value);
function aboutInfo(value:unknown):About{
 const r=row(value),v=row(r?.versions);
 if(!r||Object.keys(r).sort().join(',')!=='arch,build_time,launcher_release_id,license,name,os_release,platform,project_website,protocol,source_commit,version,version_information,versions'||r.protocol!==1||r.name!=='Jot'||
  !optional(r.version)||!text(r.platform)||!text(r.arch)||!optional(r.os_release)||!optional(r.build_time)||!optional(r.source_commit)||!optional(r.launcher_release_id)||!text(r.license)||
  r.project_website!=='https://github.com/kazwskjack/jot'||!v||Object.keys(v).sort().join(',')!=='chrome,electron,node'||!optional(v.electron)||!optional(v.chrome)||!optional(v.node)||
  typeof r.version_information!=='string'||r.version_information.length>4096||/[\x00-\x08\x0b-\x1f\x7f]/.test(r.version_information))throw Error('desktop_about_invalid');
 return r as unknown as About;
}
export default function DesktopAboutPanel({scopeKey}:{scopeKey:string}){
 const [bridge]=useState(()=>(window as Window&{jotDesktop?:{getDesktopAbout?:()=>Promise<unknown>}}).jotDesktop);
 const [info,setInfo]=useState<About|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const mounted=useRef(false),reading=useRef<object|null>(null),generation=useRef(0);
 const refresh=useCallback(async()=>{
  if(typeof bridge?.getDesktopAbout!=='function'||reading.current||!mounted.current||taskDraftScope()!==scopeKey)return;
  const flight={};reading.current=flight;setLoading(true);setError('');const request=++generation.current;
  const current=()=>mounted.current&&request===generation.current&&taskDraftScope()===scopeKey;
  try{const value=aboutInfo(await bridge.getDesktopAbout());if(current())setInfo(value);}
  catch{if(current()){setInfo(null);setError('暂时无法读取当前桌面版本信息，请稍后刷新。');}}
  finally{if(reading.current===flight)reading.current=null;if(current())setLoading(false);}
 },[bridge,scopeKey]);
 useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;generation.current+=1;reading.current=null;};},[refresh]);
 if(typeof bridge?.getDesktopAbout!=='function')return null;
 return <section className="wb-form" aria-labelledby="wb-desktop-about">
  <h3 id="wb-desktop-about">关于 Jot 桌面版</h3>
  {loading&&<p role="status">正在读取本机应用信息…</p>}{error&&<p role="alert">{error}</p>}
  {info&&<>
   <p>当前应用报告版本：<strong>{info.version??'未提供'}</strong></p>
   <p>{info.platform} · {info.arch} · {info.os_release??'系统版本未提供'}</p>
   <p className="wb-settings-note">构建时间：{info.build_time??'未提供'}；源码提交：{info.source_commit??'未提供'}</p>
   {info.launcher_release_id&&<p className="wb-settings-note">启动器发行标识：<code>{info.launcher_release_id}</code></p>}
   <p className="wb-settings-note">Electron {info.versions.electron??'未知'} · Chromium {info.versions.chrome??'未知'} · Node {info.versions.node??'未知'}</p>
   <p className="wb-settings-note">{info.license}</p>
   <details><summary>完整版本信息（可选择复制）</summary><pre tabIndex={0} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto'}}>{info.version_information}</pre></details>
  </>}
  <button type="button" disabled={loading} onClick={()=>void refresh()}>刷新版本信息</button>
 </section>;
}
