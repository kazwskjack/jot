const labels={draft:'草稿已保存',pending_review:'等待审核',review_expired:'审核已过期',review_denied:'审核未通过',waiting_dispatch:'等待派发',deferred:'等待发送时间',queued:'等待发送',sending:'正在发送',receipt_pending:'正在确认回执',delivered:'已送达',cancelled:'已取消',outcome_unknown:'发送结果未知',blocked:'暂不能发送'};
export function replyHistoryLabel(item){if(item?.status==='blocked'&&item.reason==='REPLY_SEMANTIC_CHECK_PENDING')return '校验结果待确认';return labels[item?.status]??'状态待确认';}
export function replyHistoryExplanation(item){
 if(item?.status==='outcome_unknown')return '渠道结果尚未确认，系统不会自动重发。';
 if(item?.status==='receipt_pending')return '渠道已接受回复，正在保存回执，不会再次发送。';
 if(item?.status==='queued')return '已进入发送队列，还没有送达。';
 if(item?.status==='waiting_dispatch')return item.mode==='bounded_auto_reply'?'内容校验已通过，等待宿主再次核对权限后派发；尚未发送。':'审核已记录，等待宿主处理；尚未发送。';
 if(item?.status==='deferred')return item.reason==='REPLY_QUIET_HOURS'?'当前处于静默时段，稍后再核对发送权限。':'等待回复额度或冷却时间，稍后再核对发送权限。';
 if(item?.status==='blocked'){
  if(item.reason==='REPLY_SEMANTIC_CHECK_PENDING')return '校验调用或用量结果尚未确认，系统不会自动重复调用，也不会发送。';
  if(item.reason==='REPLY_TOPIC_MISMATCH')return '回复与设定主题不一致，不会发送。';
  if(item.reason==='REPLY_TONE_MISMATCH')return '回复与设定语气不一致，不会发送。';
  if(item.reason==='REPLY_FORBIDDEN_CONTENT')return '回复涉及设定的禁区，不会发送。';
  if(item.reason==='REPLY_REQUIRES_REVIEW')return '这份内容需要人工确认，当前自动回复不会发送。';
  if(['REPLY_CONTENT_UNSUPPORTED','REPLY_CONTENT_UNCOVERED','REPLY_QUOTE_UNVERIFIED'].includes(item.reason)||item.reason?.startsWith('REPLY_EVIDENCE_'))return '回复依据不足或原始依据已不可用，不会发送。';
  if(['REPLY_POLICY_EXPIRED','REPLY_POLICY_CHANGED','REPLY_ROLE_CHANGED','REPLY_TASK_CHANGED','REPLY_TARGET_CHANGED','REPLY_RUN_CHANGED'].includes(item.reason))return '任务或目标授权已变化或过期，不会发送。';
  if(item.reason==='REPLY_CHECK_MALFORMED')return '内容校验结果格式无效，不会发送。';
  if(item.reason==='REPLY_ACCOUNTING_UNSETTLED')return '校验调用用量尚未结算，不会发送。';
  return '自动回复的内容范围检查尚未完成，不会直接发送。';
 }
 if(item?.status==='pending_review')return '请到本次对话确认这份内容。';
 if(item?.status==='review_denied')return '这份内容未获批准，不会发送。';
 if(item?.status==='review_expired')return '审核期限已过，不会按这张旧审核卡发送。';
 if(item?.status==='cancelled')return '任务或目标授权已变化，发送已停止。';
 if(item?.status==='delivered')return item.target?.kind==='conversation'?'已显示在目标对话。':'已发送到选定渠道，不代表对方已阅读。';
 return '';
}
