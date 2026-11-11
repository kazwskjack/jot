import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
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
  const language=useApplicationLanguage(),t=useApplicationText();
  const messages:Record<string,string>={
    "读取失败":t("读取失败","Read Failed"),
    "已应用":t("已应用","Applied"),
    "已保存，需要重启 Host":t("已保存，需要重启 Host","Saved; Host Restart Required"),
    "已保存，受更高优先级配置覆盖":t("已保存，受更高优先级配置覆盖","Saved; Overridden by Higher-priority Configuration"),
    "操作失败":t("操作失败","Operation Failed"),
    "操作已取消":t("操作已取消","Operation Cancelled"),
    "原操作结果尚未确认，请读取原回执。":t("原操作结果尚未确认，请读取原回执。","The original operation result is unconfirmed. Read its original receipt."),
    "用户上下文已变化，请重新进入设置。":t("用户上下文已变化，请重新进入设置。","The user context has changed. Reopen Settings."),
    "返回内容无法确认，原请求已保留。":t("返回内容无法确认，原请求已保留。","The response cannot be confirmed. The original request is retained."),
    "尚未读到原操作回执，请保留原请求并稍后读取。":t("尚未读到原操作回执，请保留原请求并稍后读取。","The original operation receipt is not available yet. Keep the original request and read again later."),
    "插件管理暂不可用，请保留原请求。":t("插件管理暂不可用，请保留原请求。","Plugin management is unavailable. Keep the original request."),
    "原操作已登记，等待 Host 处理。":t("原操作已登记，等待 Host 处理。","The original operation is registered and awaiting Host processing."),
    "Host 正在处理原操作。":t("Host 正在处理原操作。","The Host is processing the original operation."),
    "原操作结果未知，请保留原请求。":t("原操作结果未知，请保留原请求。","The original operation result is unknown. Keep the original request."),
    "当前没有待确认操作。":t("当前没有待确认操作。","There is no operation awaiting confirmation."),
    "安装或升级插件包":t("安装或升级插件包","Install or Upgrade Plugin Bundle"),
    "停用插件包":t("停用插件包","Disable Plugin Bundle"),
    "启用插件包":t("启用插件包","Enable Plugin Bundle"),
    "移除插件包":t("移除插件包","Remove Plugin Bundle"),
  };
  const showMessage=(value:string)=>{
    if(Object.hasOwn(messages,value))return messages[value];
    const result=/^(已应用|已保存，需要重启 Host|已保存，受更高优先级配置覆盖|操作失败|操作已取消) · ([A-Za-z0-9._-]{1,96})$/.exec(value);
    return result?messages[result[1]]+` · ${result[2]}`:value;
  };
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
  return <section lang={language} className="wb-form" aria-labelledby="wb-plugin-profiles" aria-busy={busy}>
    <h3 id="wb-plugin-profiles">{t("Host 插件包","Host Plugin Bundles")}</h3>
    <p className="wb-status">{t("安装与配置变更影响当前 Host profile 下的全部角色会话。每次变更均沿原宿主授权与持久回执处理。","Installation and configuration changes affect all role sessions under the current Host profile. Each change uses the original Host authorization and persistent receipt flow.")}</p>
    <button type="button" onClick={resource.reload} disabled={resource.loading}>{t("刷新包列表","Refresh Bundle List")}</button>
    {recovery.error && <p role="alert">{showMessage(recovery.error)}</p>}
    {resource.error && <p role="alert">{showMessage(resource.error)}</p>}
    {feedback && <p role="status">{showMessage(feedback)}</p>}
    {evidence !== undefined && <details>
      <summary>{t("配置与许可记录","Configuration and License Record")}</summary>
      {evidence ? <>
        <p>{t('操作前后采样 · 配置快照 ','Before/After Sampling · Configuration Snapshot ')}{evidence.after === 'captured' ? t("已保存","Saved") : t("后采样不可用","After-sample Unavailable")}</p>
        <p>{t('快照编号 ','Snapshot ID ')}<code>{evidence.snapshot_id}</code></p>
        {evidence.bundle ? <>
          <p>{evidence.bundle.name} · {evidence.bundle.version}</p>
          <p>{t('声明许可 ','Declared License ')}{evidence.bundle.license || t("未知","Unknown")}{t(' · 许可文件 ',' · License File ')}{evidence.bundle.license_file_sha256 ? t("已存档","Archived") : t("未知","Unknown")}</p>
          <p>{t('锁文件完整性记录 ','Lockfile Integrity Record ')}{evidence.bundle.integrity || t("未知","Unknown")}</p>
        </> : <p>{t("包许可与完整性记录未知。","Bundle license and integrity records are unknown.")}</p>}
      </> : <p>{t("此操作的配置与许可记录不可用。","Configuration and license records are unavailable for this operation.")}</p>}
    </details>}
    {pending && <div role="status">
      <p>{t('原请求待确认 · ','Original Request Awaiting Confirmation · ')}{command?.method} {command?.path}</p>
      <button type="button" disabled={busy} onClick={() => void perform(null, true)}>{t("读取原操作状态","Read Original Operation Status")}</button>
      <button type="button" disabled={busy} onClick={() => void perform(null)}>{t("重试原请求","Retry Original Request")}</button>
    </div>}
    <form onSubmit={event => {
      event.preventDefault();
      if (!blocked && spec.trim()) setReview({title:'安装或升级插件包', command:{path:base,method:'POST',body:{spec:spec.trim(),enabled}}});
    }}>
      <label>{t('包名、版本或受信任来源','Package Name, Version or Trusted Source')}
        <input value={spec} maxLength={512} required disabled={blocked} onChange={event => setSpec(event.target.value)} placeholder="@scope/package@1.2.3"/>
      </label>
      <label><input type="checkbox" checked={enabled} disabled={blocked} onChange={event => setEnabled(event.target.checked)}/>{t('安装后启用','Enable After Installation')}</label>
      <button type="submit" disabled={blocked || !spec.trim()}>{t("审阅安装或升级","Review Installation or Upgrade")}</button>
    </form>
    {page && <ul className="wb-settings-list">{page.bundles.map(bundle => {
      const path = `${base}/${encodeURIComponent(bundle.name)}`;
      return <li key={bundle.name}>
        <strong>{bundle.name}</strong><span>{bundle.version || t("版本未知","Version Unknown")} · {bundle.installed ? t("已安装","Installed") : t("安装状态未确认","Installation Unconfirmed")} · {bundle.enabled === undefined ? t("启用状态未知","Enabled State Unknown") : bundle.enabled ? t("已启用","Enabled") : t("未启用","Not Enabled")}</span>
        <button type="button" disabled={blocked || bundle.enabled === undefined} onClick={() => setReview({title:bundle.enabled ? '停用插件包' : '启用插件包',command:{path:path+'/enabled',method:'PATCH',body:{enabled:!bundle.enabled}}})}>{bundle.enabled ? t('停用','Disable') : t('启用','Enable')}</button>
        <button type="button" disabled={blocked} onClick={() => setReview({title:'移除插件包',command:{path,method:'DELETE',body:{}}})}>{t("移除","Remove")}</button>
      </li>;
    })}</ul>}
    {page?.bundles.length === 0 && <p className="wb-status">{t("当前没有可列出的插件包。","There are no plugin bundles to list.")}</p>}
    <dialog ref={dialog} onCancel={event => {if (busy) event.preventDefault(); else setReview(null);}} aria-labelledby="wb-plugin-profile-review">
      <h4 id="wb-plugin-profile-review">{review?showMessage(review.title):''}</h4>
      <p>{t("变更影响当前 Host profile 下的全部角色会话。请核对包来源、版本及启用状态。","Changes affect all role sessions under the current Host profile. Check the bundle source, version and enabled state.")}</p>
      {review && <pre>{JSON.stringify(review.command, null, 2)}</pre>}
      <button type="button" disabled={busy} onClick={() => setReview(null)}>{t("返回修改","Back to Edit")}</button>
      <button type="button" disabled={busy || pending || !review} onClick={() => review && void perform(review.command)}>{t("确认执行","Confirm and Execute")}</button>
    </dialog>
  </section>;
}
