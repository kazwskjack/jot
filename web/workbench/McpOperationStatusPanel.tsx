import React from 'react';
import {useResource} from './useResource';
import type {McpUnknownOperationPage} from '../../packages/gateway/contracts/types';

type Client = {readUnknownOperations:(signal?:AbortSignal)=>Promise<McpUnknownOperationPage>};
export default function McpOperationStatusPanel({client,identity}:{client:Client;identity:string}) {
  const resource=useResource(async signal=>({identity,page:await client.readUnknownOperations(signal)}),identity);
  const page=resource.data?.identity===identity?resource.data.page:null;
  return <section className="wb-form" aria-labelledby="wb-mcp-operation-status">
    <h3 id="wb-mcp-operation-status">待确认的工具操作</h3>
    <p className="wb-status">已发请求的结果需要沿原 operation 确认。重载连接后，原未知结果继续保留。</p>
    <button type="button" onClick={resource.reload} disabled={resource.loading}>读取操作状态</button>
    {resource.loading&&<p role="status">正在读取原操作状态…</p>}
    {resource.error&&<p role="alert">操作状态暂不可用，请稍后重新读取。</p>}
    {page?.items.length===0&&<p className="wb-status">当前没有结果未知的工具操作。</p>}
    {!!page?.items.length&&<>
      <p className="wb-status">最近 {page.items.length} 项结果未知的操作，最多展示 50 项。</p>
      <ul>{page.items.map(operation=><li key={operation.operation_id}>
        <code style={{overflowWrap:'anywhere'}}>{operation.operation_id}</code>
        <span> · 结果未知 · </span><time dateTime={operation.updated_at}>{operation.updated_at}</time>
      </li>)}</ul>
    </>}
  </section>;
}
