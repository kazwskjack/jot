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
  "导出范围与当前选择不一致，请重新读取": "The Export Scope Does Not Match the Current Selection. Read Again.",
  "这是二进制文件；请使用“下载原始文件”获取并校验原始字节。": "This is a binary file. Use Download Original File to retrieve and verify the original bytes.",
  "文件版本信息已过期或校验失败。已保留当前内容；刷新版本历史后可重试。": "File version metadata is stale or verification failed. Current content is retained. Refresh version history before retrying.",
  "所选版本无法读取；它可能已不存在，或当前账号无权访问。刷新版本历史后可重试。": "The selected version cannot be read. It may no longer exist or the account may lack access. Refresh version history before retrying.",
  "服务端尚未声明版本历史能力。": "The server has not declared version history capability.",
  "服务端尚未声明范围读取能力。": "The server has not declared range read capability.",
  "服务端返回的版本目录格式无效，请刷新后重试。": "The server returned an invalid version catalog. Refresh and retry.",
  "服务端返回的文本范围无效，请重试或刷新版本历史。": "The server returned an invalid text range. Retry or refresh version history.",
  "文件路径、版本或 SHA-256 与请求不一致，请刷新文件列表后重试。": "The file path, version or SHA-256 does not match the request. Refresh the file list before retrying.",
  "文件读取失败": "File Read Failed",
  "原文件草稿已变化，请重新选择任务或新增入口后核对字段。": "The original file draft changed. Select the task or add entry again and check its fields.",
  "任务字段尚无修改。": "No Task Field Changes Yet",
  "任务字段已应用到原文件草稿。请继续比较修改、确认并保存。": "Task fields were applied to the original file draft. Compare changes, confirm and save.",
  "修改后的文件超过 1 MiB 上限。": "The Modified File Exceeds the 1 MiB Limit",
  "任务字段无效。请核对唯一 ID、标题、说明和依赖 ID 的 JSON 数组。": "Invalid task fields. Check the unique ID, title, description and dependency ID JSON array.",
  "已初始化任务文件草稿，请继续比较修改并确认保存。": "Task file draft initialized. Compare changes and confirm saving.",
  "任务文件结构无法读取，请核对原文。": "The task file structure cannot be read. Check the original text."
};

// Map owned UI notices only; member messages, memory bodies and unknown errors stay original.
export function workspaceUiMessage(value:string,language:ApplicationLanguage){
 return language==='en'&&Object.hasOwn(english,value)?english[value]!:memoryUiMessage(value,language);
}
