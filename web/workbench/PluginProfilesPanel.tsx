import React, {useEffect, useMemo, useRef, useState} from 'react';
import {request, taskDraftScope} from '../jot/client';
import {useResource} from './useResource';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import {PluginProfileCommandStore, createPluginProfileClient} from './plugin-profile-client.mjs';
import type {PluginProfileBundlePage, PluginProfileResult, PluginProfileEvidence} from '../../packages/gateway/contracts/types';

type Command = {path:string; method:string; body:Record<string,unknown>};
type Review = {title:string; command:Command};
const base = '/plugin-profile/bundles';
const resultText = (value:PluginProfileResult) => ({
  applied:'已应用', 'restart-required':'已保存，需要重启 Host', overridden:'已保存，受更高优先级配置覆盖',
  failed:'操作失败', cancelled:'操作已取消',
})[value.application] + (value.error ? ` · ${value.error.code}` : '');
const errorText = (error:unknown) => {
  const code = error instanceof Error ? error.message : '';
  if (code === 'PLUGIN_OPERATION_PENDING') return '原操作结果尚未确认，请读取原回执。';
  if (code === 'PLUGIN_PROFILE_SCOPE_CHANGED') return '用户上下文已变化，请重新进入设置。';
  if (code === 'PLUGIN_PROFILE_RESPONSE_UNKNOWN') return '返回内容无法确认，原请求已保留。';
  if (code === 'PLUGIN_PROFILE_RECEIPT_NOT_FOUND') return '尚未读到原操作回执，请保留原请求并稍后读取。';
  return /^[A-Za-z0-9._-]{1,96}$/.test(code) ? code : '插件管理暂不可用，请保留原请求。';
};

export default function PluginProfilesPanel({scopeKey, onPendingChange}:{scopeKey:string; onPendingChange:(pending:boolean)=>void}) {
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const recovery = useMemo(() => {
    try {
      const store = new PluginProfileCommandStore(window.sessionStorage, scopeKey);
      return {receipt:new TaskSaveReceipt(() => crypto.randomUUID(), store), error:''};
    } catch (error) { return {receipt:null, error:errorText(error)}; }
  }, [scopeKey]);
  const receipt = recovery.receipt;
  const client = useMemo(() => createPluginProfileClient({request, receipt,
    isCurrent:() => mounted.current && currentScope.current === scopeKey && taskDraftScope() === scopeKey,
  }), [receipt, scopeKey]);
  const resource = useResource(async signal => ({owner:scopeKey, page:await client.read(signal) as PluginProfileBundlePage}), scopeKey, !!receipt);
  const page = resource.data?.owner === scopeKey && taskDraftScope() === scopeKey ? resource.data.page : null;
  const [spec, setSpec] = useState(''), [enabled, setEnabled] = useState(false);
  const [review, setReview] = useState<Review|null>(null), [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<PluginProfileEvidence|null|undefined>(undefined);
  const busyRef = useRef(false), dialog = useRef<HTMLDialogElement|null>(null);
  const pending = !!receipt?.pending;
  const blocked = busy || pending || !receipt || taskDraftScope() !== scopeKey;
  useEffect(() => {onPendingChange(busy || pending); return () => onPendingChange(false);}, [busy, pending, onPendingChange]);
  useEffect(() => {
    const prevent = (event:BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    if (busy || pending) window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [busy, pending]);
  useEffect(() => {
    if (review && !dialog.current?.open) dialog.current?.showModal();
    if (!review && dialog.current?.open) dialog.current.close();
  }, [review]);
  const isCurrent = () => mounted.current && currentScope.current === scopeKey && taskDraftScope() === scopeKey;
  async function perform(command:Command|null, readOnly = false) {
    if (!receipt || busyRef.current || !isCurrent()) return;
    busyRef.current = true; setBusy(true); setFeedback(''); setEvidence(undefined);
    try {
      if (readOnly) {
        const operation = await client.recover();
        if (!isCurrent()) return;
        if (operation?.state === 'settled') setEvidence(operation.response.evidence ?? null);
        setFeedback(operation?.state === 'settled' ? resultText(operation.response) : ({
          reserved:'原操作已登记，等待 Host 处理。', dispatched:'Host 正在处理原操作。', unknown:'原操作结果未知，请保留原请求。',
        } as Record<string,string>)[operation?.state] || '当前没有待确认操作。');
      } else {
        const original = command ?? receipt.command;
        if (!original) return;
        setReview(null);
        const result = await client.submit(original);
        if (!isCurrent()) return;
        setFeedback(resultText(result));
        setEvidence(result.evidence ?? null);
      }
      if (isCurrent()) resource.reload();
    } catch (error) {if (isCurrent()) setFeedback(errorText(error));}
    finally {
      busyRef.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  const command = receipt?.command;
  return <section className="wb-form" aria-labelledby="wb-plugin-profiles" aria-busy={busy}>
    <h3 id="wb-plugin-profiles">Host 插件包</h3>
    <p className="wb-status">安装与配置变更影响当前 Host profile 下的全部角色会话。每次变更均沿原宿主授权与持久回执处理。</p>
    <button type="button" onClick={resource.reload} disabled={resource.loading}>刷新包列表</button>
    {recovery.error && <p role="alert">{recovery.error}</p>}
    {resource.error && <p role="alert">{resource.error}</p>}
    {feedback && <p role="status">{feedback}</p>}
    {evidence !== undefined && <details>
      <summary>配置与许可记录</summary>
      {evidence ? <>
        <p>操作前后采样 · 配置快照 {evidence.after === 'captured' ? '已保存' : '后采样不可用'}</p>
        <p>快照编号 <code>{evidence.snapshot_id}</code></p>
        {evidence.bundle ? <>
          <p>{evidence.bundle.name} · {evidence.bundle.version}</p>
          <p>声明许可 {evidence.bundle.license || '未知'} · 许可文件 {evidence.bundle.license_file_sha256 ? '已存档' : '未知'}</p>
          <p>锁文件完整性记录 {evidence.bundle.integrity || '未知'}</p>
        </> : <p>包许可与完整性记录未知。</p>}
      </> : <p>此操作的配置与许可记录不可用。</p>}
    </details>}
    {pending && <div role="status">
      <p>原请求待确认 · {command?.method} {command?.path}</p>
      <button type="button" disabled={busy} onClick={() => void perform(null, true)}>读取原操作状态</button>
      <button type="button" disabled={busy} onClick={() => void perform(null)}>重试原请求</button>
    </div>}
    <form onSubmit={event => {
      event.preventDefault();
      if (!blocked && spec.trim()) setReview({title:'安装或升级插件包', command:{path:base,method:'POST',body:{spec:spec.trim(),enabled}}});
    }}>
      <label>包名、版本或受信任来源
        <input value={spec} maxLength={512} required disabled={blocked} onChange={event => setSpec(event.target.value)} placeholder="@scope/package@1.2.3"/>
      </label>
      <label><input type="checkbox" checked={enabled} disabled={blocked} onChange={event => setEnabled(event.target.checked)}/>安装后启用</label>
      <button type="submit" disabled={blocked || !spec.trim()}>审阅安装或升级</button>
    </form>
    {page && <ul className="wb-settings-list">{page.bundles.map(bundle => {
      const path = `${base}/${encodeURIComponent(bundle.name)}`;
      return <li key={bundle.name}>
        <strong>{bundle.name}</strong><span>{bundle.version || '版本未知'} · {bundle.installed ? '已安装' : '安装状态未确认'} · {bundle.enabled === undefined ? '启用状态未知' : bundle.enabled ? '已启用' : '未启用'}</span>
        <button type="button" disabled={blocked || bundle.enabled === undefined} onClick={() => setReview({title:bundle.enabled ? '停用插件包' : '启用插件包',command:{path:path+'/enabled',method:'PATCH',body:{enabled:!bundle.enabled}}})}>{bundle.enabled ? '停用' : '启用'}</button>
        <button type="button" disabled={blocked} onClick={() => setReview({title:'移除插件包',command:{path,method:'DELETE',body:{}}})}>移除</button>
      </li>;
    })}</ul>}
    {page?.bundles.length === 0 && <p className="wb-status">当前没有可列出的插件包。</p>}
    <dialog ref={dialog} onCancel={event => {if (busy) event.preventDefault(); else setReview(null);}} aria-labelledby="wb-plugin-profile-review">
      <h4 id="wb-plugin-profile-review">{review?.title}</h4>
      <p>变更影响当前 Host profile 下的全部角色会话。请核对包来源、版本及启用状态。</p>
      {review && <pre>{JSON.stringify(review.command, null, 2)}</pre>}
      <button type="button" disabled={busy} onClick={() => setReview(null)}>返回修改</button>
      <button type="button" disabled={busy || pending || !review} onClick={() => review && void perform(review.command)}>确认执行</button>
    </dialog>
  </section>;
}
