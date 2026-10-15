import React,{useState} from 'react';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus,Empty} from './AgentsPanel';
import {retrievalMatches,retrievalMethodLabel,retrievalSourceView} from './memory-retrieval.mjs';
const kinds:Record<string,string>={context_snapshot:'会话快照',continuation_snapshot:'继承会话快照',tool_query:'工具查询'};
const reasons:Record<string,string>={scope_order:'按授权范围顺序选入',keyword_match:'匹配查询词项',adapter_rank:'适配器提供的顺序',adapter_tail:'未进入适配器排序的范围尾项',inherited:'保留上一轮仍有效的快照'};
const omissions:Record<string,string>={query_miss:'未命中查询',result_limit:'结果数量限制',context_limit:'快照条数限制',duplicate:'重复内容',context_budget:'快照长度限制'};
export default function MemoryRetrievals({workspace,selection,name,onClose}:{workspace:string;selection:{agent_id:string;project_id:string};name:string;onClose:()=>void}){
 const [before,setBefore]=useState<string|undefined>(undefined),[selected,setSelected]=useState<string|null>(null);
 const identity=JSON.stringify([workspace,selection.agent_id,selection.project_id]);
 const list=useResource(signal=>workbenchApi.memoryRetrievals(workspace,selection.agent_id,before,signal),identity+before);
 const detail=useResource(signal=>workbenchApi.memoryRetrieval(workspace,selected!,signal),identity+selected,!!selected);
 const value=detail.data?.retrieval_id===selected&&retrievalMatches(detail.data,selection)?detail.data:null;
 return <section aria-label="记忆检索记录"><div className="wb-toolbar"><div><h3>记忆检索记录</h3><p>{name} 可访问的共享与私有来源。会话快照表示当时选入的资料，不代表模型实际使用了每一条。</p></div><button onClick={onClose}>返回记忆</button></div>
  {!selected?<><ResourceStatus {...list} onRetry={list.reload}/><button disabled={list.loading} onClick={list.reload}>刷新检索记录</button><div className="wb-message-list">{list.data?.items.filter(item=>retrievalMatches(item,selection)).map(item=><article key={item.retrieval_id}><strong>{kinds[item.kind]}</strong><p>{item.query||'未指定查询词，按当前范围选取。'}</p><small>{retrievalMethodLabel(item.method)} · {item.result_count} / {item.candidate_count} 条 · {new Date(item.created_at).toLocaleString()}</small><button onClick={()=>setSelected(item.retrieval_id)}>查看检索依据</button></article>)}</div>{!list.loading&&!list.error&&!list.data?.items.length&&<Empty>当前角色尚无检索记录。</Empty>}<div className="wb-actions">{before&&<button disabled={list.loading} onClick={()=>setBefore(undefined)}>查看最新检索</button>}{list.data?.next_before_id&&<button disabled={list.loading} onClick={()=>setBefore(list.data!.next_before_id!)}>查看更早检索</button>}</div></>
  :<><button onClick={()=>setSelected(null)}>返回检索列表</button><ResourceStatus {...detail} onRetry={detail.reload}/>{value&&<><div className="wb-toolbar"><h4>{kinds[value.kind]} · {retrievalMethodLabel(value.method)}</h4><button disabled={detail.loading} onClick={detail.reload}>重新核对来源</button></div><p>查询：{value.query||'未指定查询词'}</p><p>授权范围内 {value.candidate_count} 条，选入 {value.result_count} 条。{value.context_chars!==null&&<> 快照共 {value.context_chars} 字符。</>}</p>{value.fallback_reason&&<p>排序适配器{value.fallback_reason==='adapter_failed'?'暂不可用':'返回了无效结果'}，本次回退为关键词匹配。</p>}<div className="wb-actions">{Object.entries(value.excluded).filter(([,count])=>count>0).map(([key,count])=><span className="wb-badge" key={key}>{omissions[key]}：{count}</span>)}</div>
   <div className="wb-message-list">{value.references.map(reference=>{const view=retrievalSourceView(reference,value.method);return <article key={reference.memory_id}><strong>#{reference.rank} · {reference.scope==='private'?'角色私有':'项目共享'} · v{reference.version}</strong><p>{reasons[reference.reason]}{view.keyword_count!==null&&<> · 命中词项 {view.keyword_count} 个</>}</p>{reference.matched_terms.length>0&&<p>查询词：{reference.matched_terms.join('、')}</p>}{view.available?<><p>{view.preview}</p>{view.provenance.map((source:{kind:string;reference:string},index:number)=><p key={index}>{source.kind}：{source.reference}</p>)}{reference.truncated&&<small>进入快照的正文经过截断。</small>}{reference.provenance_truncated&&<small>进入快照的来源经过精简。</small>}</>:<p>此版本已不可用：可能已更正、删除、过期或失去访问权限。</p>}</article>;})}</div>{!value.references.length&&<Empty>本次没有选入记忆。</Empty>}
  </>}</>}
 </section>;
}
