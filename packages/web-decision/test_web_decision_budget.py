import contextvars
import threading
import unittest
from unittest.mock import patch

from web_decision.budget import BudgetedPredictor, BudgetFailure, bind_budget, invoke_provider_call


class WebDecisionBudgetTests(unittest.TestCase):
    def test_submission_helper_keeps_legacy_optional_but_required_mode_has_no_unmetered_fallback(self):
        calls = []
        with patch.dict('os.environ', {'UNIVERSE_WEB_BUDGET_REQUIRED': '0'}):
            self.assertEqual(invoke_provider_call('laya', 'multilingual', 'one', {'input': 'test'}, lambda wire: calls.append(wire) or 'ok'), 'ok')
        with patch.dict('os.environ', {'UNIVERSE_WEB_BUDGET_REQUIRED': '1'}):
            with self.assertRaises(BudgetFailure):
                invoke_provider_call('laya', 'multilingual', 'two', {}, lambda wire: calls.append(wire))
        self.assertEqual(calls, [{'request_id': 'one', 'payload': {'input': 'test'}}])

    def test_missing_context_cannot_invoke_provider(self):
        calls = []
        predictor = BudgetedPredictor(lambda request: calls.append(request), 'openjev', 'openjev')
        with self.assertRaises(BudgetFailure):
            predictor.predict({'request_id': 'request-1'})
        self.assertEqual(calls, [])

    def test_dispatch_ack_loss_never_invokes_or_releases_sent_attempt(self):
        calls, commands = [], []
        def command(body):
            commands.append(body['action'])
            if body['action'] == 'reserve':
                return {'fresh': True, 'receipt': {'attempt_id': 'web-attempt', 'state': 'reserved'}}
            if body['action'] == 'dispatch':
                raise OSError('lost acknowledgement')
            return {'receipt': {'attempt_id': 'web-attempt', 'state': 'unknown'}}
        with bind_budget(command):
            with self.assertRaises(BudgetFailure):
                BudgetedPredictor(lambda request: calls.append(request), 'laya', 'multilingual').predict({'request_id': 'request-1'})
        self.assertEqual(calls, [])
        self.assertEqual(commands, ['reserve', 'dispatch', 'unknown'])

    def test_original_per_call_receipt_does_not_fabricate_usage(self):
        commands, calls = [], []
        def command(body):
            commands.append(body)
            state = 'reserved' if body['action'] == 'reserve' else 'settled'
            return {'fresh': True, 'receipt': {'attempt_id': 'web-attempt', 'state': state}}
        result = {'status': 'selected', 'target': 'one'}
        with bind_budget(command):
            value = BudgetedPredictor(lambda request: calls.append(request) or result, 'openjev', 'openjev').predict({'request_id': 'request-1'})
        self.assertIs(value, result)
        self.assertEqual(len(calls), 1)
        self.assertEqual([row['action'] for row in commands], ['reserve', 'dispatch'])
        self.assertNotIn('usage', commands[-1])

    def test_replayed_reservation_and_token_route_without_usage_fail_closed(self):
        for replay in [True, False]:
            calls, commands = [], []
            def command(body):
                commands.append(body['action'])
                state = 'reserved' if body['action'] == 'reserve' else 'in_flight'
                return {'fresh': not replay, 'receipt': {'attempt_id': 'web-attempt', 'state': state}}
            with bind_budget(command):
                with self.assertRaises(BudgetFailure):
                    BudgetedPredictor(lambda request: calls.append(request), 'laya', 'multilingual').predict({'request_id': 'request-1'})
            self.assertEqual(calls, [] if replay else [{'request_id': 'request-1'}])
            self.assertEqual(commands, ['reserve'] if replay else ['reserve', 'dispatch', 'unknown'])

    def test_parallel_contexts_and_explicit_thread_copy_do_not_share_authority(self):
        seen, threads, barrier = [], [], threading.Barrier(2)
        lock = threading.Lock()
        def worker(label):
            def command(body):
                with lock:
                    seen.append((label, body['request_id'] if body['action'] == 'reserve' else body['attempt_id']))
                return {'fresh': True, 'receipt': {'attempt_id': 'web-'+label, 'state': 'reserved' if body['action'] == 'reserve' else 'settled'}}
            with bind_budget(command):
                context = contextvars.copy_context()
                barrier.wait()
                child = threading.Thread(target=lambda: context.run(BudgetedPredictor(lambda r: r, 'openjev', 'openjev').predict, {'request_id': label}))
                child.start()
                child.join()
        for label in ['one', 'two']:
            thread = threading.Thread(target=worker, args=(label,))
            thread.start()
            threads.append(thread)
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(seen), [('one', 'one'), ('one', 'web-one'), ('two', 'two'), ('two', 'web-two')])
        with self.assertRaises(BudgetFailure):
            BudgetedPredictor(lambda r: r, 'openjev', 'openjev').predict({'request_id': 'outside'})

    def test_provider_uses_reserved_snapshot_even_if_caller_mutates_input(self):
        request = {'request_id': 'one', 'instruction': 'original'}
        def command(body):
            request['instruction'] = 'changed'
            return {'fresh': True, 'receipt': {'attempt_id': 'web-one', 'state': 'reserved' if body['action'] == 'reserve' else 'settled'}}
        with bind_budget(command):
            result = BudgetedPredictor(lambda r: r, 'openjev', 'openjev').predict(request)
        self.assertEqual(result['instruction'], 'original')

    def test_token_usage_settles_exact_attempt_and_failed_settle_never_reinvokes(self):
        for lose_settlement in [False, True]:
            commands, calls = [], []
            def command(body):
                commands.append(body)
                if body['action'] == 'settle' and lose_settlement:
                    raise OSError('lost response')
                states = {'reserve': 'reserved', 'dispatch': 'in_flight', 'settle': 'settled', 'unknown': 'unknown'}
                return {'fresh': True, 'receipt': {'attempt_id': 'web-one', 'state': states[body['action']]}}
            result = {'usage': {'inputTokens': 3, 'outputTokens': 2, 'totalTokens': 5}}
            with bind_budget(command):
                predictor = BudgetedPredictor(lambda r: calls.append(r) or result, 'laya', 'multilingual', lambda r: r['usage'])
                if lose_settlement:
                    with self.assertRaises(BudgetFailure):
                        predictor.predict({'request_id': 'one'})
                else:
                    self.assertIs(predictor.predict({'request_id': 'one'}), result)
            self.assertEqual(len(calls), 1)
            self.assertEqual(commands[2], {'action': 'settle', 'attempt_id': 'web-one', 'usage': result['usage']})
            if lose_settlement:
                self.assertEqual(commands[3]['reason'], 'settlement_pending')


if __name__ == '__main__':
    unittest.main()
