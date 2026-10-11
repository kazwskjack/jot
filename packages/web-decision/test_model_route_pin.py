import unittest
from web_decision.model_route_pin import pinned_model_id, route_fingerprint, verify_route_pin

class ModelRoutePinTests(unittest.TestCase):
    def setUp(self):
        self.route = dict(id='fixture-route', provider='fixture', model='explicit-model',
            enabled=True, transport='openai_sync', api_base='https://provider.example/v1')
    def test_exact_deployment_and_explicit_model_are_accepted(self):
        pin = route_fingerprint(self.route)
        verify_route_pin(self.route, {'model': 'explicit-model'}, pin)
        self.assertRegex(pin, r'^sha256:[a-f0-9]{64}$')
    def test_routing_drift_is_rejected(self):
        pin = route_fingerprint(self.route)
        for field, value in [('model','other'), ('provider','other'), ('id','other'),
            ('api_base','https://changed.example/v1'), ('proxy','http://proxy.example'),
            ('extra_headers',{'x-route':'other'}), ('extra_query',{'region':'other'}),
            ('extra_body',{'thinking':{'type':'enabled'}}), ('max_tokens',12),
            ('api_key_env','NEW_ENV_NAME'), ('api_env_file','new-identity.env')]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, '^proxy_route_changed$'):
                verify_route_pin(dict(self.route, **{field:value}), {'model':'explicit-model'}, pin)
    def test_dynamic_alias_cannot_claim_an_explicit_model(self):
        pin = route_fingerprint(self.route)
        for model in ['active', 'other', None]:
            with self.assertRaisesRegex(ValueError, '^proxy_pinned_model_mismatch$'):
                verify_route_pin(self.route, {'model':model}, pin)
    def test_malformed_pin_cannot_enable_legacy_bypass(self):
        for pin in ['', None, 1, 'SHA256:'+'a'*64, 'sha256:'+'a'*64+'\n']:
            with self.assertRaisesRegex(ValueError, '^proxy_route_pin_invalid$'):
                verify_route_pin(self.route, {'model':'explicit-model'}, pin)
    def test_key_order_and_display_metadata_do_not_change_the_route(self):
        pin = route_fingerprint(self.route)
        self.assertEqual(pin, route_fingerprint(dict(reversed(list(self.route.items())))))
        self.assertEqual(pin, route_fingerprint(dict(self.route, label='Display name')))
    def test_wire_name_binds_the_fingerprint_and_actual_model(self):
        wire = pinned_model_id(self.route)
        pin = route_fingerprint(self.route)
        self.assertEqual(wire, 'jot-pinned:' + pin[7:] + ':explicit-model')
        verify_route_pin(self.route, {'model':wire}, pin)
        with self.assertRaisesRegex(ValueError, '^proxy_pinned_model_mismatch$'):
            verify_route_pin(self.route, {'model':'jot-pinned:'+'0'*64+':explicit-model'}, pin)
    def test_wire_name_rejects_unbounded_or_invalid_model_names(self):
        for model in [None, '', 'a'*181, 'has space', 'line\nend', 'control\x7f']:
            with self.assertRaisesRegex(ValueError, '^proxy_route_pin_invalid$'):
                pinned_model_id(dict(self.route,model=model))
        self.assertEqual(len(pinned_model_id(dict(self.route,model='a'*180))),256)
    def test_non_json_or_nonfinite_configuration_is_rejected(self):
        for value in [None, [], dict(self.route, extra_body={'temperature':float('nan')}), dict(self.route,extra_body={'object':object()})]:
            with self.assertRaisesRegex(ValueError, '^proxy_route_pin_invalid$'):
                route_fingerprint(value)

if __name__ == '__main__': unittest.main()
