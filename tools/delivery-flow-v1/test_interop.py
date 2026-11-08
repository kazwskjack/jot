"""Authoring-host contract simulations; these never assert an actual Linux execution."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from preflight import DeliveryError, canonical, sha, validate_packet
from metrics import summarize_event_files
from test_preflight import Fixture, write_json

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('linux_result_fixture', ROOT / 'tests/test_result_validate.py')
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)


class InteropTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.test-tmp'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.f = Fixture(self.root, test_name='test.mjs', test_source="import test from 'node:test';\ntest('fixture', () => {});\n")
        donor = fixture_module.ResultValidateTests()
        donor.setUp()
        try:
            result = copy.deepcopy(donor.result)
            (self.f.bundle / 'run.log').write_bytes(donor.log.read_bytes())
        finally:
            donor.tearDown()
        context = self.f.packet
        descriptor = dict(
            schema_version=1,
            source_archive_sha256=context['source_archive']['sha256'],
            source_manifest_sha256=context['source_manifest']['sha256'],
            packet_context=dict(manifest_path=context['manifest_path'], manifest_sha256=context['manifest_sha256']),
            git_delta_manifest=dict(status='pinned', path=context['manifest_path'], sha256=context['manifest_sha256']),
            candidate_commit=context['candidate_commit'], candidate_tree=context['tree'],
            tests=context['tests'], locks=context['lock_hashes'],
            argv=['node', '--test', 'test.mjs'],
            execution_environment=dict(execution_root_kind='remote', profile='test-fixture-only'),
        )
        descriptor_path = self.f.bundle / 'approved-execution.json'
        write_json(descriptor_path, descriptor)
        result.update(repo='repo', scope='synthetic', job_id='authoring-contract-simulation',
            source=self.f.result['source'], tests=self.f.tests, tests_sha256=sha(canonical(self.f.tests)),
            command=['/usr/bin/node', '--test', 'test.mjs'])
        result['event_context'].update(self.f.result['event_context'], dependencies=[], ac_ids=[],
            source_class='new_development', next_owner='13', ready_at=self.f.packet['ready_at'])
        result['artifacts'].update(source_archive='source.zip', source_manifest='source-manifest.json',
            source_manifest_sha256=self.f.packet['source_manifest']['sha256'],
            execution_descriptor='approved-execution.json',
            execution_descriptor_sha256=sha(descriptor_path.read_bytes()),
            run_root=str(self.f.bundle), raw_log_sha256=sha((self.f.bundle / 'run.log').read_bytes()))
        self.result = result
        self.save_result()

    def save_result(self):
        result_path = self.f.bundle / 'result.json'
        write_json(result_path, self.result)
        self.f.packet['test_results'][0]['sha256'] = sha(result_path.read_bytes())
        self.f.save()
        self.event = dict(schema_version=1, event_id='52a4e074-3415-4d84-b142-fb26e51a9c33', event_type='test',
            occurred_at=self.result['finished_at_utc'], repo='repo', tests_sha256=self.result['tests_sha256'],
            **self.result['event_context'], evidence=dict(kind='test_result', path='result.json',
                sha256=sha(result_path.read_bytes()), job_id=self.result['job_id'], exit_code=0, result='passed'))
        write_json(self.f.bundle / 'test-event.jsonl', self.event)

    def test_full_result_contract_and_metrics_accept_same_candidate_simulation(self):
        self.assertTrue(validate_packet(self.f.packet_path, self.root)['ok'])
        # Event draft paths are relative to its result directory; preserve that root for metrics.
        event_file = self.f.bundle / 'test-event.jsonl'
        metrics = summarize_event_files([event_file], self.f.bundle)
        self.assertEqual(metrics['event_counts']['test'], 1)
        self.assertEqual(metrics['packets'][0]['packet_id'], self.f.packet['packet_id'])
        self.assertNotIn('formal_ac_delta', metrics)

    def test_swapped_manifest_or_false_archive_identity_is_rejected(self):
        for group, key, wrong in [
            ('event_context', 'manifest_sha256', self.f.packet['source_manifest']['sha256']),
            ('source', 'package_sha256', self.f.packet['manifest_sha256']),
            ('artifacts', 'source_manifest_sha256', self.f.packet['manifest_sha256']),
        ]:
            old = self.result[group][key]
            self.result[group][key] = wrong
            self.save_result()
            with self.subTest(group=group), self.assertRaises(DeliveryError):
                validate_packet(self.f.packet_path, self.root)
            self.result[group][key] = old

    def test_tampered_retained_log_or_event_is_rejected(self):
        log = self.f.bundle / 'run.log'
        raw = log.read_bytes()
        log.write_bytes(raw + b'tamper')
        with self.assertRaises(DeliveryError):
            validate_packet(self.f.packet_path, self.root)
        log.write_bytes(raw)
        self.event['candidate_tree'] = '0' * 40
        write_json(self.f.bundle / 'test-event.jsonl', self.event)
        with self.assertRaises(DeliveryError):
            validate_packet(self.f.packet_path, self.root)


if __name__ == '__main__':
    unittest.main()
