import datetime
import json
import pathlib
import tempfile
import unittest

from preflight import DeliveryError
from queue import advance
from test_preflight import Fixture, digest, write_json


NOW = datetime.datetime(2026, 10, 24, 12, tzinfo=datetime.timezone.utc)


class QueueTests(unittest.TestCase):
    def setUp(self):
        parent = pathlib.Path(__file__).resolve().parents[2] / '.test-tmp' / 'delivery-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = pathlib.Path(self.temp.name)
        self.f = Fixture(self.root)
        self.events = self.root / 'events.jsonl'
        self.plan_path = self.root / 'approved.json'
        self.plan = dict(schema_version=1, approval_id='synthetic-approved', writer=13,
            expires_at='2026-10-25T00:00:00Z', allow_unreviewed_synthetic=True,
            entries=[dict(packet_id='packet-a', path='packet.json', sha256=digest(self.f.packet_path.read_bytes()), dependencies=[])])
        write_json(self.plan_path, self.plan)

    def tearDown(self):
        self.temp.cleanup()

    def call(self, action, **kwargs):
        return advance(self.plan_path, self.events, self.root, action, now=NOW, **kwargs)

    def test_exact_product_allowlist_requires_review_and_exact_paths(self):
        product_root = self.root / 'product'
        product_root.mkdir()
        f = Fixture(product_root, source_path='packages/gateway/synthetic.txt')
        f.packet.update(scope='synthetic', ac_ids=[])
        review = product_root / 'review.json'
        write_json(review, dict(reviewer=14, disposition='ACCEPT', candidate_commit=f.commit,
            tree=f.tree, manifest_sha256=f.packet['manifest_sha256']))
        f.packet['review'] = dict(path='review.json', sha256=digest(review.read_bytes()))
        f.save()
        entry = self.plan['entries'][0]
        entry.update(path='product/packet.json', sha256=digest(f.packet_path.read_bytes()))
        write_json(self.plan_path, self.plan)
        self.assertEqual(self.call('status')['states']['packet-a'], 'invalid')
        for paths in [['packages/gateway/'], ['packages/*'], ['../outside'],
                      [f.path, f.path], [f.path, 'packages/extra.txt']]:
            entry['allowed_paths'] = paths
            write_json(self.plan_path, self.plan)
            self.assertEqual(self.call('status')['states']['packet-a'], 'invalid')
        entry['allowed_paths'] = [f.path]
        write_json(self.plan_path, self.plan)
        self.assertEqual(self.call('claim')['states']['packet-a'], 'claimed')
        self.events.unlink()
        f.packet['review'] = None
        f.save()
        entry['sha256'] = digest(f.packet_path.read_bytes())
        write_json(self.plan_path, self.plan)
        self.assertEqual(self.call('status')['states']['packet-a'], 'invalid')

    def test_claim_and_real_integration_receipt(self):
        self.assertIs(self.call('status')['runner_execution_authorized'], False)
        claim = self.call('claim')
        self.assertIs(claim['runner_execution_authorized'], False)
        self.assertEqual(claim['event']['owner'], '13')
        self.assertEqual(claim['event']['candidate_tree'], self.f.tree)
        receipt = self.root / 'receipt.json'
        write_json(receipt, dict(packet_id='packet-a', candidate_commit=self.f.commit, tree=self.f.tree,
            manifest_sha256=self.f.packet['manifest_sha256'], status='integrated', workspace='repo',
            commit=self.f.commit, parent=self.f.base, clean=True, commands_stopped=True))
        done = self.call('record', packet_id='packet-a', claim_id=claim['claim_id'],
                         receipt=receipt, receipt_sha=digest(receipt.read_bytes()))
        self.assertIs(done['runner_execution_authorized'], False)
        self.assertEqual(done['states']['packet-a'], 'integrated')
        self.assertEqual(len(self.events.read_text().splitlines()), 2)
        with self.assertRaises(DeliveryError):
            self.call('claim', packet_id='packet-a')

    def test_expired_and_duplicate_plan_rejected(self):
        self.plan['expires_at'] = '2026-10-24T00:00:00Z'
        write_json(self.plan_path, self.plan)
        with self.assertRaises(DeliveryError):
            self.call('claim')
        self.plan['expires_at'] = '2026-10-25T00:00:00Z'
        self.plan['entries'] *= 2
        write_json(self.plan_path, self.plan)
        with self.assertRaises(DeliveryError):
            self.call('status')

    def test_duplicate_claim_and_wrong_writer_rejected(self):
        self.call('claim')
        with self.assertRaises(DeliveryError):
            self.call('claim')
        with self.assertRaises(DeliveryError):
            self.call('status', writer=14)

    def test_receipt_does_not_invent_a_git_integration(self):
        claim = self.call('claim')
        receipt = self.root / 'receipt.json'
        write_json(receipt, dict(packet_id='packet-a', candidate_commit=self.f.commit, tree=self.f.tree,
            manifest_sha256=self.f.packet['manifest_sha256'], status='integrated', workspace='repo',
            commit=self.f.base, parent=self.f.base, clean=True, commands_stopped=True))
        with self.assertRaises(DeliveryError):
            self.call('record', packet_id='packet-a', claim_id=claim['claim_id'],
                      receipt=receipt, receipt_sha=digest(receipt.read_bytes()))
        self.assertEqual(len(self.events.read_text().splitlines()), 1)

    def test_failed_packet_blocks_only_its_descendants(self):
        for name, deps in [('packet-b', ['packet-a']), ('packet-c', [])]:
            p = self.root / (name + '.json')
            packet = dict(self.f.packet, packet_id=name, dependencies=deps)
            result = dict(self.f.result, event_context=dict(self.f.result['event_context'], packet_id=name))
            result_path = self.f.bundle / (name + '-result.json')
            write_json(result_path, result)
            packet['test_results'] = [dict(path='bundle/' + result_path.name, sha256=digest(result_path.read_bytes()))]
            write_json(p, packet)
            self.plan['entries'].append(dict(packet_id=name, path=p.name, sha256=digest(p.read_bytes()), dependencies=deps))
        write_json(self.plan_path, self.plan)
        claim = self.call('claim', packet_id='packet-a')
        receipt = self.root / 'failure.json'
        write_json(receipt, dict(packet_id='packet-a', candidate_commit=self.f.commit, tree=self.f.tree,
            manifest_sha256=self.f.packet['manifest_sha256'], status='failed', error='synthetic failure'))
        result = self.call('record', packet_id='packet-a', claim_id=claim['claim_id'],
                           receipt=receipt, receipt_sha=digest(receipt.read_bytes()))
        self.assertEqual(result['states']['packet-b'], 'blocked')
        self.assertEqual(result['states']['packet-c'], 'ready')
        self.assertEqual(self.call('claim')['packet_id'], 'packet-c')

    def test_cycle_and_changed_packet_rejected_without_claim(self):
        self.plan['entries'][0]['dependencies'] = ['packet-a']
        write_json(self.plan_path, self.plan)
        with self.assertRaises(DeliveryError):
            self.call('claim')
        self.plan['entries'][0]['dependencies'] = []
        write_json(self.plan_path, self.plan)
        self.f.packet['next_owner'] = 15
        self.f.save()
        states = self.call('status')['states']
        self.assertEqual(states['packet-a'], 'invalid')
        self.assertFalse(self.events.exists() and self.events.read_bytes())

    def test_missing_historical_receipt_does_not_remain_integrated(self):
        claim = self.call('claim')
        receipt = self.root / 'receipt.json'
        write_json(receipt, dict(packet_id='packet-a', candidate_commit=self.f.commit, tree=self.f.tree,
            manifest_sha256=self.f.packet['manifest_sha256'], status='integrated', workspace='repo',
            commit=self.f.commit, parent=self.f.base, clean=True, commands_stopped=True))
        self.call('record', packet_id='packet-a', claim_id=claim['claim_id'],
                  receipt=receipt, receipt_sha=digest(receipt.read_bytes()))
        receipt.write_text('{}', encoding='utf-8')
        self.assertEqual(self.call('status')['states']['packet-a'], 'invalid')

    def test_stale_claim_can_record_failure_without_using_changed_identity(self):
        claim = self.call('claim')
        receipt = self.root / 'failure.json'
        write_json(receipt, dict(packet_id='packet-a', candidate_commit=self.f.commit, tree=self.f.tree,
            manifest_sha256=self.f.packet['manifest_sha256'], status='failed', error='packet changed after claim'))
        self.f.packet['next_owner'] = 15
        self.f.save()
        result = self.call('record', packet_id='packet-a', claim_id=claim['claim_id'],
                           receipt=receipt, receipt_sha=digest(receipt.read_bytes()))
        self.assertEqual(result['event']['queue_action'], 'failed')
        self.assertEqual(result['event']['next_owner'], '13')


if __name__ == '__main__':
    unittest.main()
