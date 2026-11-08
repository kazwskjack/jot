import datetime as dt
import json
import pathlib
import tempfile
import unittest
import types

from preflight import DeliveryError, sha, utc, validate_packet
from queue import advance
from test_preflight import Fixture, write_json
from unittest.mock import patch


class LocalFreezeTests(unittest.TestCase):
    def setUp(self):
        parent = pathlib.Path(__file__).resolve().parents[2] / '.test-tmp' / 'local-freeze-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=parent)
        self.root = pathlib.Path(self.tmp.name)
        self.f = Fixture(self.root)
        self.target = self.root / 'target'
        self.f.git('worktree', 'add', '--detach', str(self.target), self.f.base)

    def tearDown(self):
        self.f.git('worktree', 'remove', '--force', str(self.target))
        self.tmp.cleanup()

    def freeze(self, **kw):
        from local_freeze import freeze
        args = dict(repo=self.f.repo, base=self.f.base, target=self.target,
                    output=self.root / 'local', root=self.root, packet_id='local-a', owner=2,
                    paths=[self.f.path], tests=['test.py'], locks=['toolchain.lock'])
        args.update(kw)
        from preflight import R3_PROFILE_SHA
        binding = dict(owner=args['owner'], source_repo=str(args['repo']), output=str(args['output']), profile_sha256=R3_PROFILE_SHA)
        with patch('local_freeze.authorize_freeze', return_value=binding):
            return freeze(**args)

    def test_source_only_exact_target_no_archive_and_no_wip_changes(self):
        before = self.f.git('status', '--porcelain=v1'), self.f.git('rev-parse', 'HEAD')
        (self.f.repo / 'unrelated.txt').write_text('preserve me')
        objects = self.f.repo / '.git' / 'objects'
        before_objects = {str(p.relative_to(objects)): sha(p.read_bytes()) for p in objects.rglob('*') if p.is_file()}
        packet_path = self.freeze()
        self.assertEqual(before_objects, {str(p.relative_to(objects)): sha(p.read_bytes()) for p in objects.rglob('*') if p.is_file()})
        packet = json.loads(packet_path.read_bytes())
        self.assertNotEqual(pathlib.Path(packet['repo']).resolve(), self.target.resolve())
        self.assertEqual(packet['delivery_kind'], 'local_source_only')
        self.assertNotIn('source_archive', packet)
        checked = validate_packet(packet_path, self.root, scratch_root=self.root / 'checks')
        self.assertEqual(checked['base_commit'], self.f.base)
        self.assertEqual(checked['paths'], [self.f.path])
        self.assertEqual(self.f.git('rev-parse', 'HEAD'), before[1])
        self.assertEqual((self.f.repo / 'unrelated.txt').read_text(), 'preserve me')
        manifest = json.loads((packet_path.parent / 'manifest.json').read_bytes())
        self.assertEqual(manifest['files'][0]['wip_attribution'], 'unknown')
        self.assertEqual(self.f.git('status', '--porcelain=v1'), '?? unrelated.txt')
        with self.assertRaises(DeliveryError):
            self.freeze()  # immutable output
        packet.pop('delivery_kind')
        write_json(packet_path, packet)
        with self.assertRaises(DeliveryError):
            validate_packet(packet_path, self.root, scratch_root=self.root / 'checks')  # remote still requires full source

    def test_selected_dirty_test_cannot_masquerade_as_candidate_test(self):
        (self.f.repo / 'test.py').write_text('different private test')
        with self.assertRaises(DeliveryError):
            self.freeze()

    def test_target_conflict_and_credential_path_fail_before_ready(self):
        (self.target / self.f.path).parent.mkdir(parents=True)
        (self.target / self.f.path).write_text('untracked target conflict')
        with self.assertRaises(DeliveryError):
            self.freeze()
        with self.assertRaises(DeliveryError):
            self.freeze(paths=['.env'])
        self.assertFalse((self.root / 'local' / 'packet.json').exists())

    def test_queue_real_claim_and_verified_receipt_emit_process_times(self):
        packet_path = self.freeze()
        packet = json.loads(packet_path.read_bytes())
        review = self.root / 'review.json'
        write_json(review, dict(reviewer=14, disposition='ACCEPT', candidate_commit=packet['candidate_commit'],
                                tree=packet['tree'], manifest_sha256=packet['manifest_sha256']))
        packet['review'] = dict(path=str(review), sha256=sha(review.read_bytes()))
        write_json(packet_path, packet)
        plan = self.root / 'approved.json'
        write_json(plan, dict(schema_version=1, approval_id='local-approved', writer=13,
                              expires_at='2099-01-01T00:00:00Z', entries=[dict(packet_id='local-a',
                              path=str(packet_path), sha256=sha(packet_path.read_bytes()), dependencies=[])]))
        events = self.root / 'events.jsonl'
        before = dt.datetime.now(dt.timezone.utc)
        claim = advance(plan, events, self.root, 'claim')
        self.assertLessEqual(before, utc(claim['event']['received_at']))
        self.assertEqual(claim['event']['timestamp_basis'], 'process_observed')
        self.assertEqual(claim['event']['timestamp_provenance'], dict(basis='process_observed',
                         process_observed_at=claim['event']['occurred_at'], actor_reported_at=None, native_observed_at=None))
        ready = json.loads((packet_path.parent / 'ready-event.json').read_bytes())
        self.assertEqual(ready['timestamp_provenance']['process_observed_at'], ready['occurred_at'])
        self.assertFalse(claim['runner_execution_authorized'])
        self.f.git('-C', str(self.target), 'apply', '--index', str(packet_path.parent / 'forward.patch'))
        self.f.git('-C', str(self.target), 'commit', '-qm', 'actual writer integration')
        integrated_commit = self.f.git('-C', str(self.target), 'rev-parse', 'HEAD')
        receipt = self.root / 'receipt.json'
        write_json(receipt, dict(packet_id='local-a', candidate_commit=packet['candidate_commit'],
                   tree=packet['tree'], manifest_sha256=packet['manifest_sha256'], status='integrated',
                   workspace=str(self.target), commit=integrated_commit, parent=self.f.base,
                   clean=True, commands_stopped=True, integrated_at='2000-01-01T00:00:00Z'))
        done = advance(plan, events, self.root, 'record', packet_id='local-a', claim_id=claim['claim_id'],
                       receipt=receipt, receipt_sha=sha(receipt.read_bytes()))
        self.assertLessEqual(before, utc(done['event']['integrated_at']))
        self.assertFalse(done['runner_execution_authorized'])

    def test_pinned_wip_attribution_preserves_original_index(self):
        baseline = self.root / 'wip.json'
        raw = (self.f.repo / self.f.path).read_bytes()
        write_json(baseline, dict(files={self.f.path: sha(raw)}))
        packet_path = self.freeze(wip_baseline=dict(path=str(baseline), sha256=sha(baseline.read_bytes())))
        manifest = json.loads((packet_path.parent / 'manifest.json').read_bytes())
        self.assertEqual(manifest['files'][0]['wip_attribution'], 'inherited_unchanged')
        self.assertEqual(self.f.git('rev-parse', 'HEAD'), self.f.commit)

    def test_target_moves_after_freeze_cannot_be_claimed(self):
        packet_path = self.freeze()
        packet = json.loads(packet_path.read_bytes())
        review = self.root / 'review.json'
        write_json(review, dict(reviewer=14, disposition='ACCEPT', candidate_commit=packet['candidate_commit'],
                                tree=packet['tree'], manifest_sha256=packet['manifest_sha256']))
        packet['review'] = dict(path=str(review), sha256=sha(review.read_bytes()))
        write_json(packet_path, packet)
        plan = self.root / 'approved.json'
        write_json(plan, dict(schema_version=1, approval_id='local', writer=13,
                   expires_at='2099-01-01T00:00:00Z', entries=[dict(packet_id='local-a', path=str(packet_path),
                   sha256=sha(packet_path.read_bytes()), dependencies=[])]))
        (self.target / 'unrelated.txt').write_text('changed target')
        with self.assertRaises(DeliveryError):
            advance(plan, self.root / 'events.jsonl', self.root, 'claim')
        self.assertFalse((self.root / 'events.jsonl').exists())

    def test_r3_task_identity_comes_only_from_fixed_start_pin(self):
        from preflight import r3_task
        profile = self.root / 'runtime-profile.json'
        snapshot = self.root / 'trial-start-snapshot.json'
        pin = self.root / 'trial-start-pin.json'
        order = self.root / 'worker-02' / 'work-order.json'
        order.parent.mkdir()
        classes = {'M07.05': 'new_development', 'M06.06': 'inherited_wip'}
        write_json(order, dict(source_class_by_task=classes))
        write_json(snapshot, dict(schema='jot.r3.trial-start-snapshot.v1', trial_id='trial-r3',
            trial=dict(started=True, real_product_trial_started=True), work_orders=[dict(worker=2,
            primary_id='M07.05', backup_id='M06.06', work_order_path=order.as_posix(),
            work_order_sha256=sha(order.read_bytes()), source_class_by_task=classes)]))
        write_json(profile, dict(profile_id='trial-r3', trial_start_snapshot=str(snapshot), trial_start_pin=str(pin)))
        with patch('preflight.R3_PROFILE_PATH', profile), patch('preflight.R3_PROFILE_SHA', sha(profile.read_bytes())):
            with self.assertRaises(DeliveryError):
                r3_task(2, 'M07.05', self.root)  # No START pin: no inferred product event.
            write_json(pin, dict(schema='jot.r3.trial-start-pin.v1', trial_id='trial-r3', immutable=True,
                snapshot_path=snapshot.as_posix(), snapshot_sha256=sha(snapshot.read_bytes())))
            self.assertEqual(r3_task(2, 'M07.05', self.root), dict(trial_id='trial-r3',
                task_owner=2, task_id='M07.05', source_class='new_development'))
            with self.assertRaises(DeliveryError):
                r3_task(2, 'arbitrary-packet-id', self.root)
            order.write_text('changed after START')
            with self.assertRaises(DeliveryError):
                r3_task(2, 'M07.05', self.root)

    def test_r3_packet_task_differs_from_queue_producer_and_revision_id(self):
        context = dict(trial_id='jot-parallel-r3-20261025', task_owner=2, task_id='M07.05', source_class='new_development')
        with patch('local_freeze.r3_task', return_value=context), patch('preflight.r3_task', return_value=context):
            packet_path = self.freeze(task_owner=2, task_id='M07.05')
            packet = json.loads(packet_path.read_bytes())
            ready = json.loads((packet_path.parent / 'ready-event.json').read_bytes())
            self.assertEqual((ready['owner'], ready['task_owner'], ready['task_id'], ready['packet_id']),
                             ('2', 2, 'M07.05', 'local-a'))
            review = self.root / 'review.json'
            write_json(review, dict(reviewer=14, disposition='ACCEPT', candidate_commit=packet['candidate_commit'],
                tree=packet['tree'], manifest_sha256=packet['manifest_sha256']))
            packet['review'] = dict(path=str(review), sha256=sha(review.read_bytes()))
            write_json(packet_path, packet)
            plan = self.root / 'approved.json'
            write_json(plan, dict(schema_version=1, approval_id='r3', writer=13, expires_at='2099-01-01T00:00:00Z',
                entries=[dict(packet_id='local-a', path=str(packet_path), sha256=sha(packet_path.read_bytes()), dependencies=[])]))
            claim = advance(plan, self.root / 'events.jsonl', self.root, 'claim')
            self.assertEqual((claim['event']['owner'], claim['event']['task_owner'], claim['event']['task_id'],
                claim['event']['packet_id']), ('13', 2, 'M07.05', 'local-a'))

    def test_freeze_author_and_output_are_bound_to_r3_guard(self):
        from local_freeze import authorize_freeze
        config = dict(assignments=dict(workers=[dict(number=2, private_workspace=str(self.root),
                      report_directory=str(self.root / 'report'))]), policy=dict(shared_integration=str(self.target)))
        guard = types.SimpleNamespace(load_r3_config=lambda: (config, None), check_r3=lambda owner, path: {'allowed': True})
        with patch.dict('sys.modules', workspace_guard=guard), patch('pathlib.Path.cwd', return_value=self.f.repo):
            result = authorize_freeze(2, self.f.repo, self.target, self.root / 'local')
            self.assertEqual(result['owner'], 2)
            with self.assertRaises(DeliveryError):
                authorize_freeze(13, self.f.repo, self.target, self.root / 'local')
            with self.assertRaises(DeliveryError):
                authorize_freeze(2, self.f.repo, self.target, self.root.parent / 'other-author')
            guard.check_r3 = lambda owner, path: {'allowed': False}
            with self.assertRaises(DeliveryError):
                authorize_freeze(2, self.f.repo, self.target, self.root / 'local')

    def test_mutated_snapshot_rejected(self):
        packet_path = self.freeze()
        (packet_path.parent / 'source' / self.f.path).write_text('tampered')
        with self.assertRaises(DeliveryError):
            validate_packet(packet_path, self.root, scratch_root=self.root / 'checks')


if __name__ == '__main__':
    unittest.main()
