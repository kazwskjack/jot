from contextlib import ExitStack
from contextvars import copy_context
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from web_decision.budget import BudgetedPredictor, BudgetFailure, bind_budget
from web_decision.request_budget import request_budget_scope


class WebBudgetMetadataTests(unittest.TestCase):
    def test_wire_metadata_selects_only_ticket_and_fixed_host_origin(self):
        calls = []
        def client(origin, grant):
            calls.append((origin, grant))
            return lambda body: {'fresh': True, 'receipt': {'attempt_id': 'web-one', 'state': 'reserved' if body['action'] == 'reserve' else 'settled'}}
        context = SimpleNamespace(request_context=SimpleNamespace(meta={'jot_web_budget': {'protocol': 1, 'grant': 'a'*64}, 'progressToken': 'one'}))
        with patch('web_decision.request_budget.ticket_client', client):
            with request_budget_scope(context, 'http://127.0.0.1:18831', required=True):
                result = copy_context().run(BudgetedPredictor(lambda r: r, 'openjev', 'openjev').predict, {'request_id': 'one'})
        self.assertEqual(result, {'request_id': 'one'})
        self.assertEqual(calls, [('http://127.0.0.1:18831', 'a'*64)])

    def test_missing_optional_metadata_clears_an_enclosing_request_scope(self):
        command = lambda body: {'fresh': True, 'receipt': {'attempt_id': 'web-one', 'state': 'reserved' if body['action'] == 'reserve' else 'settled'}}
        predictor = BudgetedPredictor(lambda r: r, 'openjev', 'openjev')
        with bind_budget(command):
            with request_budget_scope(SimpleNamespace(request_context=SimpleNamespace(meta=None)), '', required=False):
                with self.assertRaises(BudgetFailure):
                    predictor.predict({'request_id': 'nested'})
            self.assertEqual(predictor.predict({'request_id': 'original'}), {'request_id': 'original'})

    def test_malformed_or_identity_url_claims_never_construct_a_client(self):
        for ticket in [None, 'a'*64, {'protocol': True, 'grant': 'a'*64}, {'protocol': 1, 'grant': 'bad'},
                       {'protocol': 1, 'grant': 'a'*64, 'origin': 'http://127.0.0.1:1'},
                       {'protocol': 1, 'grant': 'a'*64, 'owner_id': 'other'}]:
            context = SimpleNamespace(request_context=SimpleNamespace(meta={'jot_web_budget': ticket}))
            with patch('web_decision.request_budget.ticket_client') as client:
                with self.assertRaises(BudgetFailure):
                    with request_budget_scope(context, 'http://127.0.0.1:18831'):
                        pass
                client.assert_not_called()

    def test_sdk_model_dump_shape_and_required_missing_context(self):
        class Meta:
            def model_dump(self, **kwargs):
                return {'jot_web_budget': {'protocol': 1, 'grant': 'a'*64}}
        context = SimpleNamespace(request_context=SimpleNamespace(meta=Meta()))
        with request_budget_scope(context, 'http://127.0.0.1:18831'):
            pass  # Binding creates no network or provider call.
        with self.assertRaises(BudgetFailure):
            with request_budget_scope(None, 'http://127.0.0.1:18831', required=True):
                pass


if __name__ == '__main__':
    unittest.main()
