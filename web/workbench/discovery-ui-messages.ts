import type {ApplicationLanguage} from '../../packages/desktop/src/application-language.mjs';

const english:Record<string,string>={
  "角色信息尚未就绪，请重新读取。": "Role information is not ready. Read it again.",
  "用户范围尚未就绪，请重新读取工作台。": "The user scope is not ready. Read the workbench again.",
  "策略归属已变化，请重新读取。": "Policy ownership changed. Read it again.",
  "请填写完整的非负整数。": "Enter a complete nonnegative integer.",
  "数值不在支持的范围内。": "The value is outside the supported range.",
  "当前策略包含工作执行模式，请先核对原配置。": "The current policy includes work execution. Check the original configuration first.",
  "请先保存并重新读取策略。": "Save the policy and read it again first.",
  "角色权限已变化，请重新保存策略后再启用。": "Role permissions changed. Save the policy again before enabling it.",
  "用户范围已变化，请关闭并重新读取。": "The user scope changed. Close and read again.",
  "请先重新读取当前策略。": "Read the current policy again first.",
  "原请求不可用，请重新读取。": "The original request is unavailable. Read again.",
  "策略回执归属不符，请重新读取。": "The policy receipt ownership does not match. Read again.",
  "操作未完成": "Operation Incomplete",
  "配置无效": "Invalid Configuration",
  "读取失败": "Read Failed",
  "创建工作周期失败": "Creating the work cycle failed.",
  "等待执行": "Awaiting Execution",
  "正在启动": "Starting",
  "正在执行": "Executing",
  "等待补充": "Awaiting Additional Input",
  "等待确认": "Awaiting Confirmation",
  "正在取消": "Cancelling",
  "执行已结束": "Execution Ended",
  "部分执行": "Partially Executed",
  "执行失败": "Execution Failed",
  "已取消": "Cancelled",
  "执行已中断": "Execution Interrupted",
  "执行结果待核对": "Execution Result Unconfirmed",
  "等待审核": "Awaiting Review",
  "等待证据": "Awaiting Evidence",
  "已记录证据": "Evidence Recorded",
  "需要补充": "Additional Input Required",
  "需要确认": "Confirmation Required",
  "业务审核已确认": "Business Review Confirmed",
  "验收未通过": "Acceptance Failed",
  "业务流程已结束": "Business Process Ended",
  "执行状态待核对": "Execution State Unconfirmed",
  "业务状态待核对": "Business State Unconfirmed",
  "原验收已完成": "Original Acceptance Complete",
  "尚未验收": "Not Yet Accepted",
  "来源覆盖待核对": "Source Coverage Unconfirmed"
};

// Only owned discovery status/input messages; reports and proposed changes stay original.
export function discoveryUiMessage(value:string,language:ApplicationLanguage){
 if(language!=='en')return value;
 if(Object.hasOwn(english,value))return english[value]!;
 const coverage=/^完整读取 (0|[1-9][0-9]*) \/ (0|[1-9][0-9]*) 条来源$/.exec(value);
 if(coverage&&Number.isSafeInteger(Number(coverage[1]))&&Number.isSafeInteger(Number(coverage[2]))&&Number(coverage[1])<=Number(coverage[2]))return `Fully Read ${coverage[1]} / ${coverage[2]} Sources`;
 return value;
}
