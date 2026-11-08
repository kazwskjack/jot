import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from local_freeze import freeze
from preflight import DeliveryError, canonical, git, sha
from queue import advance


def save(path, value):
    path.write_bytes(canonical(value) + b'\n')


class StandingScopeTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[2] / '.test-tmp/r4-standing-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.source, self.target = self.root / 'source', self.root / 'target'
        for repo in (self.source, self.target):
            repo.mkdir()
            git(repo, 'init', '--quiet')
        self.path = 'packages/example/operation.py'
        file = self.source / self.path
        file.parent.mkdir(parents=True)
        file.write_text('def operation():\n    return 1\n' + '\n# unrelated\n' * 8)
        (self.source / 'check.py').write_text('assert True\n')
        (self.source / 'other.txt').write_text('baseline\n')
        git(self.source, 'add', '.')
        self.commit(self.source, 'base')
        self.base = git(self.source, 'rev-parse', 'HEAD').decode().strip()
        (self.target / '.git/objects/info/alternates').write_bytes(((self.source / '.git/objects').as_posix() + '\n').encode())
        git(self.target, 'read-tree', '--reset', '-u', self.base)
        git(self.target, 'update-ref', 'HEAD', self.base)
        file.write_text(file.read_text().replace('return 1', 'return 2'))
        self.review_root = self.root / 'reviewer14'
        self.review_root.mkdir()
        self.policy_path = self.root / 'standing-policy.json'
        self.policy = dict(schema_version=1, mode='standing_scope', writer=13, approval_id='R4-fixture',
            valid_from='2026-01-01T00:00:00Z', expires_at='2099-01-01T00:00:00Z',
            trial_id='jot-r4-regression-fixture', event_scope='preparation', target_repo=str(self.target),
            guard_profile_sha256='a' * 64,
            reviewer=dict(number=14, thread_id='01a15c3d-8ef3-7452-a7b2-88e4e018a482', report_root=str(self.review_root)),
            task_scopes=[dict(task_owner=2, task_id='M07.05', source_class='new_development', allowed_paths=[self.path])])
        save(self.policy_path, self.policy)
        self.policy_sha = sha(self.policy_path.read_bytes())
        self.events = self.root / 'writer-events.jsonl'
        self.output = self.root / 'packet-a'
        self.freeze(self.output, 'packet-a')
        self.packet_path = self.output / 'packet.json'
        self.packet = json.loads(self.packet_path.read_text())
        self.review_path = self.review_root / 'source-review.json'
        self.review = dict(source_review_version=2, reviewer=14,
            reviewer_thread_id=self.policy['reviewer']['thread_id'], disposition='ACCEPT',
            task_owner=2, task_id='M07.05', source_binding_sha256=self.packet['source_binding_sha256'])
        save(self.review_path, self.review)

    def tearDown(self):
        self.temp.cleanup()

    def commit(self, repo, message):
        git(repo, '-c', 'user.name=Delivery Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-qm', message)

    def freeze(self, output, packet_id):
        binding = dict(owner=13, source_repo=str(self.source), output=str(output),
            profile_sha256='a' * 64, timestamp_basis='process_observed', permission_issued=False)
        old_cwd = Path.cwd()
        try:
            os.chdir(self.source)
            with patch('local_freeze.authorize_freeze', return_value=binding):
                return freeze(repo=self.source, base=self.base, target=self.target, output=output,
                    root=self.root, packet_id=packet_id, owner=13, paths=[self.path], tests=['check.py'], locks=[],
                    task_owner=2, task_id='M07.05', scope_policy=self.policy_path, scope_policy_sha=self.policy_sha)
        finally:
            os.chdir(old_cwd)

    def call(self, action, **extra):
        args = dict(approval_sha=self.policy_sha)
        if action != 'record':
            args.update(packet_path=self.packet_path, packet_sha=sha(self.packet_path.read_bytes()),
                source_review=self.review_path, source_review_sha=sha(self.review_path.read_bytes()))
        args.update(extra)
        return advance(self.policy_path, self.events, self.root, action, **args)

    def moved_target(self, same_file=False):
        path = self.target / (self.path if same_file else 'other.txt')
        path.write_text(path.read_text() + '# independent target change\n')
        git(self.target, 'add', '--', str(path.relative_to(self.target)))
        self.commit(self.target, 'independent target change')
        return git(self.target, 'rev-parse', 'HEAD').decode().strip()

    def integrate(self, claim):
        git(self.target, 'apply', '--cached', str(self.output / 'forward.patch'))
        git(self.target, 'checkout-index', '--force', '--', self.path)
        self.commit(self.target, 'actual integration')
        receipt = self.root / 'receipt.json'
        save(receipt, dict(packet_id=self.packet['packet_id'], candidate_commit=self.packet['candidate_commit'],
            source_tree=self.packet['tree'], manifest_sha256=self.packet['manifest_sha256'], status='integrated',
            workspace=str(self.target), commit=git(self.target, 'rev-parse', 'HEAD').decode().strip(),
            target_base=claim['event']['target_base'], target_tree=claim['event']['target_tree'],
            target_delta_sha256=claim['event']['target_delta_sha256'], clean=True, commands_stopped=True))
        return self.call('record', packet_id=self.packet['packet_id'], claim_id=claim['claim_id'],
            receipt=receipt, receipt_sha=sha(receipt.read_bytes()))

    def test_unrelated_head_and_same_file_offset_reuse_exact_source_review(self):
        original_review = self.review_path.read_bytes()
        target_base = self.moved_target(same_file=True)
        index_before = (self.target / '.git/index').read_bytes()
        objects_before = sorted(str(p) for p in (self.target / '.git/objects').rglob('*'))
        claim = self.call('claim')
        self.assertEqual(claim['event']['target_base'], target_base)
        self.assertNotEqual(target_base, self.base)
        self.assertEqual(self.review_path.read_bytes(), original_review)
        self.assertEqual((self.target / '.git/index').read_bytes(), index_before)
        self.assertEqual(sorted(str(p) for p in (self.target / '.git/objects').rglob('*')), objects_before)
        self.assertFalse(claim['runner_execution_authorized'])
        self.assertEqual(self.integrate(claim)['event']['queue_action'], 'integrated')

    def test_overlapping_target_hunk_requires_incremental_review(self):
        path = self.target / self.path
        path.write_text(path.read_text().replace('return 1', 'return 7'))
        git(self.target, 'add', '--', self.path)
        self.commit(self.target, 'overlapping target change')
        with self.assertRaisesRegex(DeliveryError, 'composition|overlap|incremental'):
            self.call('claim')
        self.assertFalse(self.events.exists())

    def test_changed_source_cannot_reuse_old_review(self):
        path = self.source / self.path
        path.write_text(path.read_text().replace('return 2', 'return 3'))
        output = self.root / 'packet-b'
        self.freeze(output, 'packet-b')
        result = self.call('status', packet_path=output / 'packet.json', packet_sha=sha((output / 'packet.json').read_bytes()))
        self.assertEqual(result['states']['packet-b'], 'invalid')
        self.assertIn('source', result['errors']['packet-b'])

    def test_scope_and_reviewer_boundary_fail_closed(self):
        self.policy['task_scopes'][0]['allowed_paths'] = ['packages/another.py']
        save(self.policy_path, self.policy)
        with self.assertRaisesRegex(DeliveryError, 'approval|policy'):
            self.call('status')
        self.policy_sha = sha(self.policy_path.read_bytes())
        self.assertEqual(self.call('status')['states']['packet-a'], 'invalid')
        self.policy['task_scopes'][0]['allowed_paths'] = [self.path]
        save(self.policy_path, self.policy)
        self.policy_sha = sha(self.policy_path.read_bytes())
        wrong = self.root / 'forged-review.json'
        save(wrong, self.review)
        result = self.call('status', source_review=wrong, source_review_sha=sha(wrong.read_bytes()))
        self.assertEqual(result['states']['packet-a'], 'invalid')
        self.assertFalse(self.events.exists())
        legacy = dict(reviewer=14, disposition='ACCEPT', candidate_commit=self.packet['candidate_commit'],
                      tree=self.packet['tree'], manifest_sha256=self.packet['manifest_sha256'])
        save(self.review_path, legacy)
        self.assertEqual(self.call('status')['states']['packet-a'], 'invalid')

    def test_same_source_cannot_be_applied_twice_even_with_new_packet_id(self):
        self.integrate(self.call('claim'))
        changed = dict(self.packet, packet_id='renamed-packet')
        path = self.output / 'renamed.json'
        save(path, changed)
        with self.assertRaisesRegex(DeliveryError, 'claimable|consumed|duplicate'):
            self.call('claim', packet_path=path, packet_sha=sha(path.read_bytes()))
        # A new trial and a fresh exact review must not reset source consumption.
        from source_binding import source_key
        self.policy['trial_id'] = 'renamed-trial'
        save(self.policy_path, self.policy)
        self.policy_sha = sha(self.policy_path.read_bytes())
        changed['trial_id'] = self.policy['trial_id']
        changed['source_binding_sha256'] = source_key(changed, json.loads((self.output / 'manifest.json').read_text()))
        save(path, changed)
        save(self.review_path, dict(self.review, source_binding_sha256=changed['source_binding_sha256']))
        with self.assertRaisesRegex(DeliveryError, 'claimable|consumed|duplicate'):
            self.call('claim', packet_path=path, packet_sha=sha(path.read_bytes()))
        self.assertEqual(len(self.events.read_text().splitlines()), 2)

    def test_target_cas_is_independent_of_source_acceptance(self):
        claim = self.call('claim')
        self.moved_target()
        with self.assertRaises(DeliveryError):
            self.integrate(claim)

    def test_changed_packet_can_close_failure_but_never_replay_source(self):
        claim = self.call('claim')
        self.packet_path.write_bytes(b'changed after claim')
        receipt = self.root / 'failed.json'
        save(receipt, dict(packet_id=self.packet['packet_id'], candidate_commit=self.packet['candidate_commit'],
            source_tree=self.packet['tree'], manifest_sha256=self.packet['manifest_sha256'],
            status='failed', error='source evidence changed; no integration attempted'))
        result = self.call('record', packet_id=self.packet['packet_id'], claim_id=claim['claim_id'],
                           receipt=receipt, receipt_sha=sha(receipt.read_bytes()))
        self.assertEqual(result['event']['queue_action'], 'failed')
        renamed = self.output / 'retry.json'
        save(renamed, dict(self.packet, packet_id='retry'))
        with self.assertRaisesRegex(DeliveryError, 'claimable|consumed|duplicate'):
            self.call('claim', packet_path=renamed, packet_sha=sha(renamed.read_bytes()))


class PatchOperationTests(unittest.TestCase):
    def test_only_offsets_and_object_ids_are_ignored(self):
        from source_binding import patch_operations
        original = b'index aaa..bbb 100644\n@@ -1,2 +1,2 @@ def operation():\n-return 1\n+return 2\n'
        moved = original.replace(b'aaa..bbb', b'ccc..ddd').replace(b'-1,2 +1,2', b'-8,2 +8,2')
        self.assertEqual(patch_operations(original), patch_operations(moved))
        self.assertNotEqual(patch_operations(original), patch_operations(original.replace(b'def operation', b'def changed')))
        self.assertNotEqual(patch_operations(original), patch_operations(original.replace(b'return 2', b'return 3')))
        self.assertNotEqual(patch_operations(original), patch_operations(original.replace(b'100644', b'100755')))


if __name__ == '__main__':
    unittest.main()
