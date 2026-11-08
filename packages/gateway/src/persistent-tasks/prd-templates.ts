import type {TaskPrdTemplate as Template} from '../../contracts/types.ts';
const base='# [项目名称]\n\n## 目标\n[目标]\n\n## 用户与范围\n[用户与范围]\n\n## 验收标准\n[验收标准]\n\n## 依赖与边界\n[依赖与边界]';
const definitions:(Omit<Template,'content'|'placeholders'>&{sections:string[]})[]=[
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
  const content=[base,...sections].join('\n\n');
  return {...template,content,placeholders:[...new Set([...content.matchAll(placeholder)].map(match=>match[1]!))]};
 });
}

export function renderPrdTemplate(id:unknown,input:unknown){
 if(typeof id!=='string')throw Error('invalid_prd_template');
 const template=prdTemplates().find(item=>item.id===id);
 if(!template)throw Error('prd_template_not_found');
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid_prd_template_values');
 const values=input as Record<string,unknown>,entries=Object.entries(values);
 if(entries.length>32||entries.some(([key,value])=>!key||key.length>100||/[\u0000-\u001f\u007f]/.test(key)
  ||typeof value!=='string'||value.length>2000))throw Error('invalid_prd_template_values');
 const content=template.content.replace(placeholder,(literal:string,key:string)=>Object.hasOwn(values,key)?values[key] as string:literal);
 const bytes=Buffer.from(content,'utf8');
 if(bytes.length>1048576||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)
  ||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)!==content)throw Error('invalid_prd_template_values');
 return {template,content};
}
