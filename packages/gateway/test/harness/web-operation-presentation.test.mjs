import assert from 'node:assert/strict'
import test from 'node:test'

import { webOperationPresentation } from '../../src/harness/web-operation-presentation.ts'

test('web operation snapshots use the real operation kind and safe item labels', () => {
  assert.deepEqual(webOperationPresentation('read_page', 'running'), {
    action: 'read', operation: 'fetch', title: '正在读取网页', itemActionLabel: '读取页面',
  })
  assert.deepEqual(webOperationPresentation('browse', 'succeeded'), {
    action: 'browse', operation: 'interact', title: '网页交互完成', itemActionLabel: '页面交互',
  })
  assert.deepEqual(webOperationPresentation('execute', 'waiting_confirmation'), {
    action: 'execute', operation: 'execute', title: '网页操作等待确认', itemActionLabel: '网页操作',
  })
})

test('unknown operation kinds are not mislabeled as page reads', () => {
  assert.deepEqual(webOperationPresentation('future_kind', 'running'), {
    action: 'web_operation', operation: 'web_operation', title: '正在处理网页任务',
  })
})
