import test from 'node:test';import assert from 'node:assert/strict';import {replyHistoryLabel,replyHistoryExplanation} from './reply-history-ui.mjs';
test('queued, uncertain and receipt-only replies never display as delivered',()=>{
 for(const [status,label]of [['queued','等待发送'],['sending','正在发送'],['receipt_pending','正在确认回执'],['outcome_unknown','发送结果未知'],['pending_review','等待审核'],['delivered','已送达'],['cancelled','已取消']])assert.equal(replyHistoryLabel({status}),label);
 assert.match(replyHistoryExplanation({status:'queued'}),/还没有送达/);assert.match(replyHistoryExplanation({status:'outcome_unknown'}),/不会自动重发/);assert.match(replyHistoryExplanation({status:'receipt_pending'}),/不会再次发送/);
});
test('quiet deferral and review denial explain the actual boundary instead of claiming delivery',()=>{
 assert.equal(replyHistoryLabel({status:'review_denied'}),'审核未通过');assert.match(replyHistoryExplanation({status:'deferred',reason:'REPLY_QUIET_HOURS'}),/静默时段/);assert.match(replyHistoryExplanation({status:'deferred',reason:'REPLY_RATE_LIMIT'}),/回复额度/);assert.match(replyHistoryExplanation({status:'blocked',reason:'REPLY_SEMANTIC_CHECK_REQUIRED'}),/内容范围/);assert.equal(replyHistoryLabel({status:'future-status'}),'状态待确认');
});

test('autonomous assessment state is distinguished from human approval and uncertain delivery',()=>{
 assert.equal(replyHistoryLabel({status:'blocked',reason:'REPLY_SEMANTIC_CHECK_PENDING'}),'校验结果待确认');
 assert.match(replyHistoryExplanation({status:'blocked',reason:'REPLY_SEMANTIC_CHECK_PENDING'}),/不会自动重复调用/);
 assert.match(replyHistoryExplanation({status:'waiting_dispatch',mode:'bounded_auto_reply'}),/内容校验已通过/);
 assert.equal(replyHistoryExplanation({status:'waiting_dispatch',mode:'bounded_auto_reply'}).includes('审核已记录'),false);
 assert.match(replyHistoryExplanation({status:'blocked',reason:'REPLY_TOPIC_MISMATCH'}),/主题/);
 assert.match(replyHistoryExplanation({status:'blocked',reason:'REPLY_REQUIRES_REVIEW'}),/需要人工确认/);
 assert.match(replyHistoryExplanation({status:'blocked',reason:'REPLY_EVIDENCE_UNAVAILABLE'}),/依据/);
 assert.match(replyHistoryExplanation({status:'blocked',reason:'REPLY_POLICY_EXPIRED'}),/授权/);
});
