import type {Activity,Run} from './types';
import {nativeFileSearchRows} from '../../packages/gateway/src/events/native-file-search-text.js';

export type ToolActivity=Exclude<Activity,{kind:'compaction'}>;
export type ActivityRun={status:Run['status'];created_at?:string};
export type ActivityReveal={activityId:string;key:string};
export type ActivityRow={activity:ToolActivity;depth:number;children:number;issue?:string};
export const activityKindLabels:Record<ToolActivity['kind'],string>={
 search:'搜索',browse:'网页',file_read:'读取文件',file_edit:'修改文件',command:'命令',subagent:'子任务',crawl:'批量抓取',
};
export const activityStatusLabels={pending:'等待执行',running:'执行中',waiting:'等待继续',succeeded:'已完成',partial:'部分完成',failed:'失败',cancelled:'已取消',unknown:'状态待确认'};
export function activityDisplayStatus(activity:ToolActivity,run?:ActivityRun){
 if(['pending','running','waiting'].includes(activity.status)&&run
  &&['succeeded','failed','cancelled','interrupted','partial'].includes(run.status))return 'unknown';
 return activity.status;
}

/** Only fields in the original public activity contract enter the display/search. */
export function activityDetailRows(activity:ToolActivity):Array<{label:string;value:string}>{
 const rows:Array<{label:string;value:string}>=[];
 const add=(label:string,value:unknown)=>{
  if(typeof value==='string'&&value)rows.push({label,value});
  else if(typeof value==='number'&&Number.isFinite(value))rows.push({label,value:String(value)});
  else if(Array.isArray(value)){
   const strings=value.filter((item):item is string=>typeof item==='string');
   if(strings.length)rows.push({label,value:strings.join('\n')});
  }
 };
 const detail=activity.detail;
 add('工具',detail.tool_name);add('操作',detail.action);add('网址',detail.url);add('网址列表',detail.urls);
 switch(activity.kind){
  case 'search':
   add('搜索词',activity.detail.queries);add('搜索数量',activity.detail.query_count);
   add('提供方',activity.detail.provider);add('来源',activity.detail.source_ids);
   break;
  case 'browse':
   add('网页操作',activity.detail.operation);add('操作编号',activity.detail.operation_id);
   add('操作类型',activity.detail.operation_kind);add('请求编号',activity.detail.request_id);
   add('代次',activity.detail.generation);add('修订',activity.detail.revision);add('事件游标',activity.detail.event_cursor);
   add('接收数量',activity.detail.accepted_count);add('请求动作',activity.detail.requested_action_types);
   add('动作记录数量',activity.detail.action_trace_count);add('已记录动作',activity.detail.traced_action_types);
   for(const [name,count] of Object.entries(activity.detail.counts??{}))add(`计数 ${name}`,count);
   add('操作状态',activity.detail.operation_status);add('结果',activity.detail.browse_outcome);
   add('来源',activity.detail.source_ids);add('截图文件',activity.detail.screenshot_artifact_id);
   add('验证状态',activity.detail.verification_statuses);add('已验证动作',activity.detail.verified_action_types);
   for(const item of activity.detail.items??[]){
    add(`网页条目 ${item.position+1}`,[item.item_id,item.status,item.url,item.reason_code,item.action_label,item.result_ref]);
    add(`网页条目 ${item.position+1} 尝试次数`,item.attempt);
   }
   break;
  case 'file_read':
   add('文件',activity.detail.display_path);add('版本',activity.detail.version);add('文件编号',activity.detail.artifact_id);break;
  case 'file_edit':
   add('文件',activity.detail.display_path);add('文件操作',activity.detail.operation);add('改动状态',activity.detail.change_status);
   add('原版本',activity.detail.before_version);add('新版本',activity.detail.after_version);
   add('原内容摘要',activity.detail.before_sha256);add('新内容摘要',activity.detail.after_sha256);
   add('文件编号',activity.detail.artifact_id);add('差异文件',activity.detail.diff_artifact_id);break;
  case 'command':
   add('命令',activity.detail.display_command);add('退出码',activity.detail.exit_code);add('输出文件',activity.detail.output_artifact_id);break;
  case 'subagent':
   if(activity.detail.child_run_id!==activity.run_id)add('子运行',activity.detail.child_run_id);
   add('成员会话',activity.detail.child_conversation_id);add('原成员',activity.detail.child_session_ref);add('成员角色',activity.detail.role_ref);
   add('委派请求',activity.detail.native_request_id);add('成员预留',activity.detail.reservation_id);
   add('公开摘要',activity.detail.summary);break;
  case 'crawl':
   add('批次',activity.detail.batch_id);add('抓取操作',activity.detail.operation);
   add('请求数量',activity.detail.requested_count);add('完成数量',activity.detail.completed_count);add('失败数量',activity.detail.failed_count);
   for(const error of activity.detail.errors??[])add(`失败条目 ${error.input_index+1}`,[error.error_code,error.url]);
   break;
 }
 if((activity.kind==='search'||activity.kind==='subagent')&&['glob','grep'].includes(String(activity.detail.tool_name))&&activity.detail.file_search)
  rows.push(...nativeFileSearchRows(activity.detail.file_search));
 if(detail.result_artifacts?.length)add('结果引用文件',detail.result_artifacts.map(artifact=>`${artifact.artifact_id} · 版本 ${artifact.version} · ${artifact.sha256}`));
 add('开始时间',activity.started_at);add('结束时间',activity.ended_at);add('错误编号',activity.error_code);
 add('父步骤',activity.parent_activity_id);add('步骤编号',activity.activity_id);add('工具调用',activity.tool_call_id);add('尝试编号',activity.attempt_id);
 return rows;
}

export type ActivityArtifactTarget=
 |{kind:'file';artifactId:string;label:string;version?:number;sha256?:string;partIndex?:number}
 |{kind:'diff';artifactId:string;label:string;fromVersion:number;toVersion:number;beforeSha256?:string;afterSha256?:string};

/** Versioned references come directly from the public step, never inferred from a path. */
export function activityArtifactTargets(activity:ToolActivity):ActivityArtifactTarget[]{
 const targets:ActivityArtifactTarget[]=[];
 if(activity.kind==='file_read'&&activity.detail.artifact_id){
  targets.push({kind:'file',artifactId:activity.detail.artifact_id,label:'查看文件',
   ...(activity.detail.version!==undefined?{version:activity.detail.version}:{})});
 }
 if(activity.kind==='file_edit'){
  const detail=activity.detail;
  if(detail.artifact_id){
   targets.push({kind:'file',artifactId:detail.artifact_id,label:'查看修改后文件',
    ...(detail.after_version!==undefined?{version:detail.after_version}:{}),...(detail.after_sha256?{sha256:detail.after_sha256}:{})});
   if(detail.before_version!==undefined&&detail.before_version>0){
    targets.push({kind:'file',artifactId:detail.artifact_id,label:'查看修改前文件',version:detail.before_version,
     ...(detail.before_sha256?{sha256:detail.before_sha256}:{})});
   }
   if(detail.before_version!==undefined&&detail.before_version>0&&detail.after_version!==undefined&&detail.after_version>0&&detail.before_version!==detail.after_version){
    targets.push({kind:'diff',artifactId:detail.artifact_id,label:'查看版本差异',fromVersion:detail.before_version,toVersion:detail.after_version,
     ...(detail.before_sha256?{beforeSha256:detail.before_sha256}:{}),...(detail.after_sha256?{afterSha256:detail.after_sha256}:{})});
   }
  }
  if(detail.diff_artifact_id)targets.push({kind:'file',artifactId:detail.diff_artifact_id,label:'查看差异文件'});
 }
 if(activity.kind==='command'&&activity.detail.output_artifact_id)targets.push({kind:'file',artifactId:activity.detail.output_artifact_id,label:'查看命令输出'});
 if(activity.kind==='browse'&&activity.detail.screenshot_artifact_id)targets.push({kind:'file',artifactId:activity.detail.screenshot_artifact_id,label:'查看截图'});
 for(const [index,artifact] of (activity.detail.result_artifacts??[]).entries()){
  targets.push({kind:'file',artifactId:artifact.artifact_id,version:artifact.version,sha256:artifact.sha256,label:`查看结果引用文件 ${index+1}`});
 }
 return targets;
}

/** Iterative forest traversal keeps missing parents, cycles and deep traces visible. */
export function activityForest(activities:ToolActivity[]):ActivityRow[]{
 const values=[...activities].sort((a,b)=>a.started_at.localeCompare(b.started_at)||a.activity_id.localeCompare(b.activity_id));
 const byId=new Map(values.map(activity=>[activity.activity_id,activity]));
 const parents=new Map<string,string>(),issues=new Map<string,string>();
 for(const activity of values){
  const parent=activity.parent_activity_id;
  if(!parent)continue;
  if(parent===activity.activity_id)issues.set(activity.activity_id,'父步骤关联指向自身');
  else if(!byId.has(parent))issues.set(activity.activity_id,'父步骤不在当前运行的已加载记录中');
  else parents.set(activity.activity_id,parent);
 }
 const checked=new Set<string>();
 for(const activity of values){
  const path=new Set<string>();let current:string|undefined=activity.activity_id;
  while(current&&!checked.has(current)){
   if(path.has(current)){parents.delete(current);issues.set(current,'父步骤关联存在循环，已单独展示');break;}
   path.add(current);current=parents.get(current);
  }
  for(const id of path)checked.add(id);
 }
 const children=new Map<string,ToolActivity[]>(),roots:ToolActivity[]=[];
 for(const activity of values){
  const parent=parents.get(activity.activity_id);
  if(parent){const siblings=children.get(parent)??[];siblings.push(activity);children.set(parent,siblings);}
  else roots.push(activity);
 }
 const stack=roots.slice().reverse().map(activity=>({activity,depth:0})),rows:ActivityRow[]=[];
 while(stack.length){
  const entry=stack.pop()!,nested=children.get(entry.activity.activity_id)??[],issue=issues.get(entry.activity.activity_id);
  rows.push({...entry,children:nested.length,...(issue?{issue}:{})});
  for(let index=nested.length-1;index>=0;index--)stack.push({activity:nested[index]!,depth:entry.depth+1});
 }
 return rows;
}

export function activityIsActive(activity:ToolActivity,run?:ActivityRun){
 return ['pending','running','waiting'].includes(activityDisplayStatus(activity,run));
}

export type ActivityProgress={total:number;active:number;succeeded:number;failed:number;cancelled:number;partial:number;unknown:number;latest?:ToolActivity};
/** Aggregate the existing flattened forest without rescanning every descendant for each parent. */
export function activityTreeProgress(rows:ActivityRow[],run?:ActivityRun){
 const empty=():ActivityProgress=>({total:0,active:0,succeeded:0,failed:0,cancelled:0,partial:0,unknown:0});
 const newer=(a:ToolActivity|undefined,b:ToolActivity|undefined)=>!a?b:!b?a:b.started_at>a.started_at||b.started_at===a.started_at&&b.activity_id>a.activity_id?b:a;
 const merge=(target:ActivityProgress,value:ActivityProgress)=>{
  for(const key of ['total','active','succeeded','failed','cancelled','partial','unknown'] as const)target[key]+=value[key];
  const latest=newer(target.latest,value.latest);if(latest)target.latest=latest;
 };
 const add=(target:ActivityProgress,activity:ToolActivity)=>{
  target.total++;const status=activityDisplayStatus(activity,run);
  if(['pending','running','waiting'].includes(status)){target.active++;const latest=newer(target.latest,activity);if(latest)target.latest=latest;}
  else if(['succeeded','failed','cancelled','partial'].includes(status))target[status as 'succeeded'|'failed'|'cancelled'|'partial']++;
  else target.unknown++;
 };
 const total=empty(),descendants=new Map<string,ActivityProgress>(),pending:Array<{depth:number;progress:ActivityProgress}>=[];
 for(let index=rows.length-1;index>=0;index--){
  const row=rows[index]!,nested=empty();
  while(pending.length&&pending.at(-1)!.depth>row.depth)merge(nested,pending.pop()!.progress);
  descendants.set(row.activity.activity_id,nested);
  const subtree={...nested};add(subtree,row.activity);add(total,row.activity);pending.push({depth:row.depth,progress:subtree});
 }
 return {total,descendants};
}

export function visibleActivityRows(rows:ActivityRow[],expanded:Record<string,boolean>,run?:ActivityRun){
 const visible:ActivityRow[]=[];
 let hiddenDepth:number|undefined;
 for(const row of rows){
  if(hiddenDepth!==undefined&&row.depth>hiddenDepth)continue;
  hiddenDepth=undefined;visible.push(row);
  if(!(expanded[row.activity.activity_id]??activityIsActive(row.activity,run)))hiddenDepth=row.depth;
 }
 return visible;
}

export function activitySearchText(activity:ToolActivity,run?:ActivityRun){
 const status=activityDisplayStatus(activity,run);
 return [activityKindLabels[activity.kind],activity.title,activityStatusLabels[status]??activityStatusLabels.unknown,
  ...activityDetailRows(activity).flatMap(detail=>[detail.label,detail.value])].join('\n');
}
