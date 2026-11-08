import type {TaskPrdTemplate as Template} from '../../contracts/types.ts';
const base='# [项目名称]\n\n## 目标\n[目标]\n\n## 用户与范围\n[用户与范围]\n\n## 验收标准\n[验收标准]\n\n## 依赖与边界\n[依赖与边界]';
const taskRequest='# 原 DSH 任务生成请求\n\n## 提示词\n[任务提示词]\n\n## 优先级\n[优先级]\n原生优先级对应 high=90、medium=50、low=10。\n\n## 已有依赖原生 ID\n[依赖原生ID]\n\n## 原任务生成流程\n完整读取本请求后，在原任务账本追加一项原生子任务。由原 DSH 根据提示词生成标题和可核验的验收条件，沿原 tasks.upsert 设置对应优先级及上述依赖，保留返回的真实原生子任务 ID。生成的步骤继续通过原 tasks.next 与文件计划审阅。沿用原 owner、角色、Goal、工具权限和累计预算。资料不足时说明阻塞并请求补充。';
const definitions:(Omit<Template,'content'|'placeholders'>&{sections:string[]})[]=[
 {id:'task-request',name:'提示词生成原生任务',category:'task',description:'提示词、优先级和已有依赖交给原 DSH，经原账本与计划回执生成任务',sections:[]},
 {id:'web-app',name:'Web 应用',category:'web',description:'页面、服务与数据协作的应用需求',sections:[
  '## 页面与交互\n列出页面、角色入口、主要操作、空状态、错误状态和无障碍要求。\n[页面与交互]',
  '## 服务与数据\n说明服务接口、数据模型、状态变化、权限校验和现有调用方兼容要求。\n[服务与数据]',
  '## 运行与交付\n写明性能目标、浏览器及设备范围、部署配置、可观测信息和交付节点。\n[运行与交付]',
 ]},
 {id:'api',name:'REST API',category:'backend',description:'接口契约、数据保护与服务运行需求',sections:[
  '## 接口契约\n列出资源、方法、路径、输入输出、分页和稳定错误码。说明现有客户端的兼容要求。\n[接口契约]',
  '## 数据与权限\n明确身份认证、授权边界、敏感字段、事务、幂等、并发及迁移约束。\n[数据与权限]',
  '## 服务运行\n明确限流、超时、性能、健康状态、日志和版本交付要求。\n[服务运行]',
 ]},
 {id:'mobile-app',name:'移动应用',category:'mobile',description:'移动端流程、设备能力与发布需求',sections:[
  '## 用户流程\n说明核心页面、导航、手势、辅助功能和不同屏幕的表现。\n[用户流程]',
  '## 设备与数据\n列出设备及系统范围、权限用途、离线状态、同步、通知和数据保护要求。\n[设备与数据]',
  '## 移动端交付\n说明启动及交互性能、资源占用、服务依赖、打包配置和发布节点。\n[移动端交付]',
 ]},
 {id:'data-analysis',name:'数据分析',category:'data',description:'数据来源、分析方法和成果交付需求',sections:[
  '## 数据来源\n记录数据来源及版本、字段含义、授权范围、质量问题和更新方式。\n[数据来源]',
  '## 分析过程\n明确问题、清洗规则、计算或建模方法、假设和可复现所需配置。\n[分析过程]',
  '## 成果与使用\n说明指标、图表、报告格式、解释限制、交付文件和使用入口。\n[成果与使用]',
 ]},
];
const placeholder=/\[([^\]\r\n]{1,100})\]/g;

/** Native templates retain the existing goal/scope/acceptance/dependency format. */
export function prdTemplates():Template[]{
 return definitions.map(({sections,...template})=>{
  const content=[template.id==='task-request'?taskRequest:base,...sections].join('\n\n');
  return {...template,content,placeholders:[...new Set([...content.matchAll(placeholder)].map(match=>match[1]!))]};
 });
}

export function renderPrdTemplate(id:unknown,input:unknown){
 if(typeof id!=='string')throw Error('invalid_prd_template');
 const template=prdTemplates().find(item=>item.id===id);
 if(!template)throw Error('prd_template_not_found');
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid_prd_template_values');
 const values=input as Record<string,unknown>,entries=Object.entries(values);
 const fieldLimits=new Map<string,number>(id==='task-request'?[['任务提示词',1048576],['依赖原生ID',10240]]:[]);
 if(entries.length>32||entries.some(([key,value])=>!key||key.length>100||/[\u0000-\u001f\u007f]/.test(key)
  ||typeof value!=='string'||value.length>(fieldLimits.get(key)??2000)))throw Error('invalid_prd_template_values');
 let resolved=values,dependencies:string[]|undefined;
 if(id==='task-request'){
  if(entries.some(([key])=>!['任务提示词','优先级','依赖原生ID'].includes(key))||typeof values['任务提示词']!=='string'||!values['任务提示词'].trim())throw Error('invalid_prd_template_values');
  const priority=values['优先级']??'medium';
  if(!['high','medium','low'].includes(String(priority)))throw Error('invalid_prd_template_values');
  let parsed:unknown;try{parsed=JSON.parse(String(values['依赖原生ID']??'[]'));}catch{throw Error('invalid_prd_template_values');}
  if(!Array.isArray(parsed)||parsed.length>50||parsed.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(parsed).size!==parsed.length)throw Error('invalid_prd_template_values');
  dependencies=parsed as string[];
  resolved={...values,'优先级':priority,'依赖原生ID':JSON.stringify(dependencies)};
 }
 const content=template.content.replace(placeholder,(literal:string,key:string)=>Object.hasOwn(resolved,key)?resolved[key] as string:literal);
 const bytes=Buffer.from(content,'utf8');
 if(bytes.length>1048576||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)
  ||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)!==content)throw Error('invalid_prd_template_values');
 return {template,content,...(dependencies===undefined?{}:{task_dependencies:dependencies})};
}
