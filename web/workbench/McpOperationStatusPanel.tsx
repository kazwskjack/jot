import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import React from 'react';
import {useResource} from './useResource';
import type {McpUnknownOperationPage} from '../../packages/gateway/contracts/types';

type Client = {readUnknownOperations:(signal?:AbortSignal)=>Promise<McpUnknownOperationPage>};
export default function McpOperationStatusPanel({client,identity}:{client:Client;identity:string}) {
  const language=useApplicationLanguage(),t=useApplicationText();
  const resource=useResource(async signal=>({identity,page:await client.readUnknownOperations(signal)}),identity);
  const page=resource.data?.identity===identity?resource.data.page:null;
  return <section lang={language} className="wb-form" aria-labelledby="wb-mcp-operation-status">
    <h3 id="wb-mcp-operation-status">{t("待确认的工具操作","Unconfirmed Tool Operations")}</h3>
    <p className="wb-status">{t("已发请求的结果需要沿原 operation 确认。重载连接后，原未知结果继续保留。","Dispatched request results must be confirmed using their original operation. Reloading the connection retains the original unknown results.")}</p>
    <button type="button" onClick={resource.reload} disabled={resource.loading}>{t("读取操作状态","Read Operation Status")}</button>
    {resource.loading&&<p role="status">{t("正在读取原操作状态…","Reading Original Operation Status…")}</p>}
    {resource.error&&<p role="alert">{t("操作状态暂不可用，请稍后重新读取。","Operation status is unavailable. Read it again later.")}</p>}
    {page?.items.length===0&&<p className="wb-status">{t("当前没有结果未知的工具操作。","There are no tool operations with unknown results.")}</p>}
    {!!page?.items.length&&<>
      <p className="wb-status">{t(`最近 ${page.items.length} 项结果未知的操作，最多展示 50 项。`,`The latest ${page.items.length} operations with unknown results; up to 50 are shown.`)}</p>
      <ul>{page.items.map(operation=><li key={operation.operation_id}>
        <code style={{overflowWrap:'anywhere'}}>{operation.operation_id}</code>
        <span>{t(" · 结果未知 · "," · Result Unknown · ")}</span><time dateTime={operation.updated_at}>{operation.updated_at}</time>
      </li>)}</ul>
    </>}
  </section>;
}
