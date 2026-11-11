import type {ApplicationLanguage} from '../../packages/desktop/src/application-language.mjs';

const english:Record<string,string>={
  "命令输入已排队等待原生确认，登录结果请查看提供方原始输出。": "Command input is queued for native acknowledgement. Check the provider’s original output for the login result.",
  "无法恢复历史终端请求": "Cannot Recover Historical Terminal Requests",
  "无法保留原终端请求": "Cannot Retain the Original Terminal Request",
  "终端回执暂时无法核对，原请求已保留。": "The terminal receipt cannot be reconciled right now. The original request is retained.",
  "原请求已结束等待，请重读原回执。": "Waiting for the original request has ended. Read its original receipt again.",
  "原终端操作仍在处理中，请稍后核对。": "The original terminal operation is still processing. Reconcile it later.",
  "原终端操作结果仍未知，原请求已保留。": "The original terminal operation result remains unknown. The original request is retained.",
  "无法读取原生终端": "Cannot Read Native Terminals",
  "原生终端环境暂不可用，可尝试加载原会话执行环境。": "The native terminal environment is unavailable. You can try loading the original session environment.",
  "原会话执行环境已加载，清单展示当前 Host 实际保留的终端。": "The original session environment is loaded. The list shows terminals actually retained by the current Host.",
  "原会话正由其他写入者或子代理持有，请稍后重试。": "Another writer or subagent holds the original session. Try again later.",
  "原持久会话已不可用。": "The original persistent session is unavailable.",
  "当前会话加载已达并发范围，请稍后重试。": "Session loading has reached the concurrency limit. Try again later.",
  "原会话加载暂未确认，可重试读取原会话。": "Loading the original session is unconfirmed. You can retry reading it.",
  "历史终端请求已确认完成。": "The historical terminal request is confirmed complete.",
  "终端操作结果尚未确认": "The terminal operation result is unconfirmed",
  "历史终端请求结果尚未确认": "The historical terminal request result is unconfirmed",
  "无法保留结束等待请求": "Cannot Retain the End-wait Request",
  "终端连接已关闭": "Terminal Connection Closed",
  "终端数据流不完整": "Terminal Stream Incomplete",
  "终端连接已结束，可重新连接。": "The terminal connection has ended. You can reconnect.",
  "正在连接原生终端…": "Connecting to Native Terminal…",
  "复制未完成，可在当前焦点稳定后重试。": "Copying did not complete. Retry after the current focus is stable.",
  "已复制文本。": "Text copied.",
  "复制失败，可选择文本后使用系统复制操作。": "Copy failed. Select text and use the system copy action.",
  "无法读取剪贴板，请使用系统粘贴操作。": "Cannot read the clipboard. Use the system paste action.",
  "终端渲染器释放未能确认，原生附着已取消。": "Terminal renderer disposal is unconfirmed. The native attachment was cancelled.",
  "连接已关闭，尚未确认的终端输入结果未知。重新连接后请先查看屏幕。": "The connection is closed. Unacknowledged terminal input results are unknown. Check the screen after reconnecting.",
  "连接已断开": "Disconnected",
  "系统复制暂不可用，可使用复制文本按钮重试。": "System copy is unavailable. Retry with the copy text button.",
  "原生终端连接超时，可重新连接。": "The native terminal connection timed out. You can reconnect.",
  "WebGL 上下文已释放，已切换默认终端渲染。": "The WebGL context was released. Switched to default terminal rendering.",
  "当前环境使用默认终端渲染。": "This environment uses default terminal rendering.",
  "终端屏幕基线不匹配": "Terminal Screen Baseline Mismatch",
  "输入发送结果尚未确认，连接已关闭。请重连并核对屏幕后再操作。": "Input delivery is unconfirmed and the connection is closed. Reconnect and check the screen before continuing.",
  "终端输出序号不连续，请重新连接恢复屏幕。": "Terminal output sequence is discontinuous. Reconnect to restore the screen.",
  "只读终端": "Read-only Terminal",
  "已连接 · 可输入": "Connected · Writable",
  "已连接 · 只读，重连可申请控制权": "Connected · Read-only; Reconnect to Request Control",
  "无法连接原生终端": "Cannot Connect to Native Terminal",
  "控制权已转移，未发送的输入已清除。": "Control was transferred. Unsent input was cleared.",
  "输入超过当前原生缓冲范围，请分段粘贴。": "Input exceeds the current native buffer limit. Paste in smaller parts.",
  "输入超过当前原生字节或缓冲范围，请分段粘贴。": "Input exceeds the current native byte or buffer limit. Paste in smaller parts.",
  "终端输入确认序号不匹配": "Terminal Input Acknowledgement Sequence Mismatch",
  "终端控制权已转移，可重新连接。": "Terminal control was transferred. You can reconnect.",
  "终端进程已经结束。": "The terminal process has ended.",
  "终端资源加载失败，可重新连接。": "Terminal assets failed to load. You can reconnect.",
  "终端资源接口不匹配": "Terminal Asset Interface Mismatch"
};

// Only owned terminal notices are translated; PTY content and unknown errors stay original.
export function terminalUiMessage(value:string,language:ApplicationLanguage){
 if(language!=='en')return value;
 if(Object.hasOwn(english,value))return english[value]!;
 const ended=/^请求 ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}) 已结束等待，执行结果保留为未知。已发出的操作仍可能完成。$/.exec(value);
 if(ended)return `Waiting for request ${ended[1]} has ended; its result remains unknown. An already dispatched operation may still complete.`;
 if(value==='进程已结束')return 'Process Ended';
 const exit=/^进程已结束 · 退出码 (-?(?:0|[1-9][0-9]*))$/.exec(value);
 if(exit&&Number.isSafeInteger(Number(exit[1])))return `Process Ended · Exit Code ${exit[1]}`;
 return value;
}
