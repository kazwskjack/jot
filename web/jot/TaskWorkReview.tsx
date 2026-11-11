import {useApplicationLanguage,useApplicationText} from './application-language';
import React,{useState} from 'react';
import type {TaskWorkReview,WorkReviewEntry} from './types';

function Inventory({label,items}:{label:string;items:WorkReviewEntry[]}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [offset,setOffset]=useState(0);
 return <details lang={language}><summary>{label}{t(`（${items.length} 项）`,` (${items.length} items)`)}</summary><ul>{items.slice(offset,offset+50).map(item=><li key={item.path}>{item.kind==='directory'?<><code>{item.path}</code> · {t('文件夹','Directory')}</>:<details><summary><code>{item.path}</code> · {t(`${item.bytes} 字节`,`${item.bytes} bytes`)}{item.executable?t(' · 可执行',' · Executable'):''}</summary><small style={{display:'block',overflowWrap:'anywhere'}}>SHA-256 {item.sha256}</small></details>}</li>)}</ul>
 {items.length>50&&<nav aria-label={t(label+'分页',label+' Pages')}><button type="button" disabled={offset===0} onClick={()=>setOffset(n=>Math.max(0,n-50))}>{t('上一页','Previous Page')}</button><span>{offset+1}–{Math.min(offset+50,items.length)} / {items.length}</span><button type="button" disabled={offset+50>=items.length} onClick={()=>setOffset(n=>n+50)}>{t('下一页','Next Page')}</button></nav>}</details>;
}
/** Original frozen review only; no apply, Git or checkpoint action is granted. */
export default function TaskWorkReviewView({value,publication=false}:{value:TaskWorkReview;publication?:boolean}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const labels:Record<string,string>={'检查记录':t('检查记录','Inspection Record'),'原始版本':t('原始版本','Original Version'),'结果版本':t('结果版本','Result Version'),'改动清单':t('改动清单','Change List')};
 const names={add:t("新增","Added"),delete:t("删除","Deleted"),replace:t("替换","Replaced"),modify:t("修改","Modified"),rename:t("重命名","Renamed")};
 const [offset,setOffset]=useState(0),changes=value.diff.changes;
 return <section lang={language} aria-label={t("完整任务改动","Full Task Changes")} style={{overflowWrap:'anywhere',minWidth:0}}><h4>{t('完整任务改动','Full Task Changes')}</h4><p>{t(`共 ${changes.length} 项改动`,`${changes.length} changes`)} · {publication?t('原始隔离工作区改动清单','Original Isolated Workspace Change List'):t('隔离工作区结果，尚未发布到项目','Isolated workspace results, not yet published to the project')}</p>
 <ul>{changes.slice(offset,offset+50).map((change,i)=><li key={offset+i}>{names[change.kind]} · <code>{change.from?`${change.from} → `:''}{change.path}</code></li>)}</ul>
 {changes.length>50&&<nav aria-label={t("改动分页","Change Pages")}><button type="button" disabled={offset===0} onClick={()=>setOffset(n=>Math.max(0,n-50))}>{t('上一页','Previous Page')}</button><span>{offset+1}–{Math.min(offset+50,changes.length)} / {changes.length}</span><button type="button" disabled={offset+50>=changes.length} onClick={()=>setOffset(n=>n+50)}>{t('下一页','Next Page')}</button></nav>}
 <Inventory label={t('原始版本完整清单','Complete Original Version Inventory')} items={value.base_manifest.entries}/><Inventory label={t('结果版本完整清单','Complete Result Version Inventory')} items={value.result_manifest.entries}/>
 <details><summary>{t('本次选定方案原文','Original Selected Plan')}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value.selected_objective}</pre></details>
 <details><summary>{t('版本核验信息','Version Verification Information')}</summary><dl>{[['检查记录',value.inspection_sha256],['原始版本',value.diff.base_sha256],['结果版本',value.diff.result_sha256],['改动清单',value.diff.diff_sha256]].map(([name,hash])=><React.Fragment key={name}><dt>{name&&Object.hasOwn(labels,name)?labels[name]:name}</dt><dd style={{overflowWrap:'anywhere'}}>{hash}</dd></React.Fragment>)}</dl></details>
 </section>;
}
