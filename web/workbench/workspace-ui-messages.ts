import type {ApplicationLanguage} from '../../packages/desktop/src/application-language.mjs';
import {memoryUiMessage} from './memory-ui-messages';

const english:Record<string,string>={
  "当前服务尚未启用此能力，请在服务接入完成后重试。": "This service has not enabled this capability. Try again after service integration is complete.",
  "角色与任务可保存；执行宿主尚未就绪": "Roles and tasks can be saved; the execution Host is not ready yet.",
  "工作区选择回执无法读取，请核对服务端当前选择。": "The workspace selection receipt cannot be read. Check the current server selection.",
  "默认工作区已确认。": "Default Workspace Confirmed",
  "工作区选择失败": "Workspace Selection Failed",
  "请选择成员并填写消息": "Select Members and Enter a Message",
  "发送未完成": "Sending Incomplete",
  "请填写记忆内容（最多 20000 字）": "Enter Memory Content (Up to 20,000 Characters)",
  "来源最多 20 条": "Up to 20 Provenance Entries Are Allowed",
  "请填写来源类型和引用（类型最多 60 字，引用最多 2048 字）": "Enter Provenance Types and References (Types Up to 60 Characters, References Up to 2048)",
  "来源版本和替代记忆 ID 最多 128 字": "Source Revision and Superseded Memory ID Are Limited to 128 Characters",
  "有效期须为真实日期，且包含 Z 或时区偏移": "Expiry Must Be a Real Date with Z or a Time-zone Offset",
  "导出范围与当前选择不一致，请重新读取": "The Export Scope Does Not Match the Current Selection. Read Again."
};

// Map owned UI notices only; member messages, memory bodies and unknown errors stay original.
export function workspaceUiMessage(value:string,language:ApplicationLanguage){
 return language==='en'&&Object.hasOwn(english,value)?english[value]!:memoryUiMessage(value,language);
}
