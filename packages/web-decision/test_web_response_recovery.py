import unittest
from web_decision.budget import BudgetedPredictor, BudgetFailure, bind_budget
from web_decision.response_codec import encode_response, decode_response


class Store:
    def __init__(self, lost_record=False, token=False, lost_settle=False):
        self.state = None
        self.response = None
        self.lost_record, self.token, self.lost_settle = lost_record, token, lost_settle
        self.dispatches = 0
    def __call__(self, body):
        action = body['action']
        if action == 'reserve':
            fresh = self.state is None
            self.state = self.state or 'reserved'
            return {'fresh': fresh, 'receipt': {'attempt_id': 'web-one', 'state': self.state}}
        if action == 'dispatch':
            self.dispatches += 1
            self.state = 'in_flight' if self.token else 'settled'
        if action == 'response_record':
            self.response = {key: body[key] for key in ['response_json', 'response_hash']}
            if self.lost_record:
                self.lost_record = False
                raise OSError('lost acknowledgement')
            return {'response': self.response}
        if action == 'response_read':
            return {'response': self.response}
        if action == 'settle':
            self.state = 'settled'
            if self.lost_settle:
                self.lost_settle = False
                raise OSError('lost settlement acknowledgement')
        return {'receipt': {'attempt_id': 'web-one', 'state': self.state}}


class WebResponseRecoveryTests(unittest.TestCase):
    def test_uncommitted_response_stays_pending_and_retry_cannot_resend(self):
        class MissingStore(Store):
            def __call__(self, body):
                if body['action'] == 'response_record':
                    raise OSError('storage unavailable')
                return super().__call__(body)
        store, calls = MissingStore(), []
        with bind_budget(store):
            predictor = BudgetedPredictor(lambda r: calls.append(r) or {'status': 'selected'}, 'openjev', 'openjev', journal=True)
            for _ in range(2):
                with self.assertRaises(BudgetFailure):
                    predictor.predict({'request_id': 'one'})
        self.assertIsNone(store.response)
        self.assertEqual(len(calls), 1)
        self.assertEqual(store.dispatches, 1)

    def test_oversized_http_body_cannot_become_a_successful_record(self):
        class Response:
            status_code = 200
            content = b'x'*131073
            headers = {}
        with self.assertRaises(BudgetFailure):
            encode_response(Response())

    def test_lost_record_ack_reads_original_and_replay_does_not_invoke(self):
        store, calls = Store(lost_record=True), []
        with bind_budget(store):
            predictor = BudgetedPredictor(lambda r: calls.append(r) or {'status': 'selected'}, 'openjev', 'openjev', journal=True)
            self.assertEqual(predictor.predict({'request_id': 'one'}), {'status': 'selected'})
            self.assertEqual(predictor.predict({'request_id': 'one'}), {'status': 'selected'})
        self.assertEqual(len(calls), 1)
        self.assertEqual(store.dispatches, 1)

    def test_lost_settlement_ack_reuses_recorded_actual_usage_without_second_call(self):
        store, calls = Store(token=True, lost_settle=True), []
        result = {'usage': {'inputTokens': 3, 'outputTokens': 2, 'totalTokens': 5}}
        with bind_budget(store):
            predictor = BudgetedPredictor(lambda r: calls.append(r) or result, 'laya', 'multilingual', lambda r: r['usage'], journal=True)
            with self.assertRaises(BudgetFailure):
                predictor.predict({'request_id': 'one'})
            self.assertEqual(predictor.predict({'request_id': 'one'}), result)
        self.assertEqual(len(calls), 1)
        self.assertEqual(store.dispatches, 1)

    def test_absent_or_corrupt_original_is_unresolved_and_never_resends(self):
        for response in [None, {'response_json': '{}', 'response_hash': 'a'*64}]:
            store, calls = Store(), []
            store.state, store.response = 'settled', response
            with bind_budget(store):
                with self.assertRaises(BudgetFailure):
                    BudgetedPredictor(lambda r: calls.append(r), 'openjev', 'openjev', journal=True).predict({'request_id': 'one'})
            self.assertEqual(calls, [])

    def test_http_codec_preserves_bytes_status_and_retry_only(self):
        class Response:
            status_code = 429
            content = b'{"reason":"busy"}'
            headers = {'Retry-After': '3', 'Authorization': 'synthetic-test-value', 'Set-Cookie': 'synthetic-cookie'}
        encoded = encode_response(Response())
        restored = decode_response(encoded)
        self.assertEqual(restored.status_code, 429)
        self.assertEqual(restored.content, Response.content)
        self.assertEqual(restored.headers, {'Retry-After': '3'})
        self.assertNotIn('synthetic-test-value', encoded['response_json'])
        self.assertNotIn('synthetic-cookie', encoded['response_json'])


if __name__ == '__main__':
    unittest.main()
