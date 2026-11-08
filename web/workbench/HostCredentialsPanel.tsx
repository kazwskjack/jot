import React from 'react';
import type {HostAdminClient} from './types';
import {useResource} from './useResource';

export default function HostCredentialsPanel({client,scopeKey}:{client:HostAdminClient;scopeKey:string}){
 const resource=useResource(signal=>client.credentials!(signal),scopeKey,typeof client.credentials==='function');
 if(!client.credentials||resource.data?.enabled===false)return null;
 return <section aria-label="Host 凭据引用"><h3>凭据引用</h3>
  {resource.loading&&<p role="status">正在读取凭据管理入口…</p>}
  {resource.error&&<p role="alert">凭据管理入口暂不可用。<button type="button" onClick={resource.reload}>重新读取</button></p>}
  {resource.data?.enabled&&resource.data.owner_url&&<>
   <p>在原生 Host 中管理引用状态、轮换凭据和撤销存储值。环境变量仍提供同名值时，撤销结果会显示待处理。</p>
   <a href={resource.data.owner_url} target="_blank" rel="noopener noreferrer">打开 Host 凭据管理</a>
  </>}
 </section>;
}
