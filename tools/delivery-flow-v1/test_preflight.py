import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from preflight import DeliveryError, validate_packet


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True) + '\n', encoding='utf-8')


class Fixture:
    def __init__(self, root, packet_id='packet-a', source_path='tools/delivery-flow-v1/synthetic.txt', test_name='test.py', test_source='assert True\n'):
        self.root = root
        self.repo = root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        (self.repo / test_name).write_text(test_source, encoding='utf-8')
        (self.repo / 'toolchain.lock').write_text('stdlib-only\n', encoding='utf-8')
        self.git('add', '.')
        self.git('commit', '-qm', 'synthetic baseline')
        self.base = self.git('rev-parse', 'HEAD')
        self.path = source_path
        target = self.repo / self.path
        target.parent.mkdir(parents=True)
        target.write_text('synthetic tool\n', encoding='utf-8')
        self.git('add', '.')
        self.git('commit', '-qm', 'synthetic candidate')
        self.commit = self.git('rev-parse', 'HEAD')
        self.tree = self.git('rev-parse', 'HEAD^{tree}')
        self.bundle = root / 'bundle'
        self.bundle.mkdir()
        (self.bundle / 'source.txt').write_bytes(target.read_bytes())
        for name, left, right in [('forward', self.base, self.commit), ('reverse', self.commit, self.base)]:
            (self.bundle / (name + '.patch')).write_bytes(self.git_bytes('diff', '--binary', left, right))
        self.manifest = dict(base_commit=self.base, candidate_commit=self.commit, target_tree=self.tree,
            files=[dict(path=self.path, base_blob=None, candidate_blob=self.git('rev-parse', 'HEAD:' + self.path),
                        candidate_sha256=digest(target.read_bytes()), snapshot='source.txt')],
            forward_sha256=digest((self.bundle / 'forward.patch').read_bytes()),
            reverse_sha256=digest((self.bundle / 'reverse.patch').read_bytes()))
        write_json(self.bundle / 'manifest.json', self.manifest)
        self.tests = {test_name: digest((self.repo / test_name).read_bytes())}
        self.locks = {'toolchain.lock': digest((self.repo / 'toolchain.lock').read_bytes())}
        archive = self.bundle / 'source.zip'
        archive.write_bytes(self.git_bytes('archive', '--format=zip', self.commit))
        archive_files = [dict(path=p, sha256=digest(self.git_bytes('show', self.commit + ':' + p)))
                         for p in self.git('ls-tree', '-r', '--name-only', self.commit).splitlines()]
        write_json(self.bundle / 'source-manifest.json', dict(commit=self.commit, tree=self.tree,
            archive_sha256=digest(archive.read_bytes()), files=archive_files, test_entry=test_name))
        self.result = dict(status='PASS', exit_code=0,
            source=dict(commit=self.commit, tree=self.tree,
                        package_sha256=digest(archive.read_bytes()), lock_sha256=self.locks),
            tests_sha256=digest(json.dumps(self.tests, sort_keys=True, separators=(',', ':')).encode()),
            command=['python', test_name], formal_acceptance_credit='NONE', evidence_kind='authoring_host',
            tests=self.tests, repo='repo', event_context=dict(packet_id=packet_id, owner='13',
                candidate_commit=self.commit, candidate_tree=self.tree, manifest_path='bundle/manifest.json',
                manifest_sha256=digest((self.bundle / 'manifest.json').read_bytes())),
            artifacts=dict(source_archive='source.zip', source_manifest='source-manifest.json',
                source_manifest_sha256=digest((self.bundle / 'source-manifest.json').read_bytes())))
        write_json(self.bundle / 'result.json', self.result)
        self.packet = dict(schema_version=1, packet_id=packet_id, owner=13, ac_ids=[], scope='synthetic',
            repo='repo', candidate_commit=self.commit, tree=self.tree,
            manifest_path='bundle/manifest.json', manifest_sha256=digest((self.bundle / 'manifest.json').read_bytes()),
            dependencies=[], tests=self.tests, lock_hashes=self.locks,
            source_archive=dict(path='bundle/source.zip', sha256=digest(archive.read_bytes())),
            source_manifest=dict(path='bundle/source-manifest.json', sha256=digest((self.bundle / 'source-manifest.json').read_bytes())),
            test_results=[dict(path='bundle/result.json', sha256=digest((self.bundle / 'result.json').read_bytes()))],
            review=None, next_owner=13, ready_at='2026-10-24T00:00:00Z', source_class='new_development')
        self.packet_path = root / 'packet.json'
        self.save()

    def git_bytes(self, *args):
        return subprocess.check_output(['git', '-c', 'core.autocrlf=false', '-c', 'user.name=Delivery Fixture',
            '-c', 'user.email=fixture@example.invalid', *args], cwd=self.repo, stderr=subprocess.DEVNULL)

    def git(self, *args):
        return self.git_bytes(*args).decode().strip()

    def save(self):
        write_json(self.packet_path, self.packet)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        parent = pathlib.Path(__file__).resolve().parents[2] / '.test-tmp' / 'delivery-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = pathlib.Path(self.temp.name)
        self.f = Fixture(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_fixed_source_and_patch_roundtrip(self):
        result = validate_packet(self.f.packet_path, self.root)
        self.assertTrue(result['ok'])
        self.assertEqual(result['paths'], [self.f.path])
        self.assertEqual(result['review_status'], 'NOT_REVIEWED')

    def test_archive_and_packet_manifest_hashes_are_independent(self):
        self.assertNotEqual(self.f.result['source']['package_sha256'], self.f.packet['manifest_sha256'])
        self.assertNotEqual(self.f.packet['source_manifest']['sha256'], self.f.packet['manifest_sha256'])
        self.assertTrue(validate_packet(self.f.packet_path, self.root)['ok'])
        for group, key, wrong in [
            ('source', 'package_sha256', self.f.packet['manifest_sha256']),
            ('event_context', 'manifest_sha256', self.f.packet['source_manifest']['sha256']),
            ('artifacts', 'source_manifest_sha256', self.f.packet['manifest_sha256']),
        ]:
            old = self.f.result[group][key]
            self.f.result[group][key] = wrong
            write_json(self.f.bundle / 'result.json', self.f.result)
            self.f.packet['test_results'][0]['sha256'] = digest((self.f.bundle / 'result.json').read_bytes())
            self.f.save()
            with self.subTest(group=group), self.assertRaises(DeliveryError):
                validate_packet(self.f.packet_path, self.root)
            self.f.result[group][key] = old

    def test_wrong_tree_is_rejected(self):
        self.f.packet['tree'] = self.f.base
        self.f.save()
        with self.assertRaises(DeliveryError):
            validate_packet(self.f.packet_path, self.root)

    def test_snapshot_or_patch_tamper_is_rejected(self):
        for name in ['source.txt', 'forward.patch', 'reverse.patch']:
            with self.subTest(name=name):
                p = self.f.bundle / name
                original = p.read_bytes()
                p.write_bytes(original + b'tampered')
                with self.assertRaises(DeliveryError):
                    validate_packet(self.f.packet_path, self.root)
                p.write_bytes(original)

    def test_tests_and_locks_must_match_git(self):
        for key in ['tests', 'lock_hashes']:
            with self.subTest(key=key):
                old = dict(self.f.packet[key])
                self.f.packet[key] = {next(iter(old)): '0' * 64}
                self.f.save()
                with self.assertRaises(DeliveryError):
                    validate_packet(self.f.packet_path, self.root)
                self.f.packet[key] = old

    def test_result_source_and_test_identity_are_checked(self):
        self.f.result['tests_sha256'] = '0' * 64
        write_json(self.f.bundle / 'result.json', self.f.result)
        self.f.packet['test_results'][0]['sha256'] = digest((self.f.bundle / 'result.json').read_bytes())
        self.f.save()
        with self.assertRaises(DeliveryError):
            validate_packet(self.f.packet_path, self.root)

    def test_missing_identity_and_outside_path_are_rejected(self):
        del self.f.packet['owner']
        self.f.save()
        with self.assertRaises(DeliveryError):
            validate_packet(self.f.packet_path, self.root)
        self.f.packet['owner'] = 13
        self.f.packet['manifest_path'] = '../outside.json'
        self.f.save()
        with self.assertRaises(DeliveryError):
            validate_packet(self.f.packet_path, self.root)

    def test_manifest_cannot_omit_a_changed_path(self):
        self.f.manifest['files'] = []
        write_json(self.f.bundle / 'manifest.json', self.f.manifest)
        self.f.packet['manifest_sha256'] = digest((self.f.bundle / 'manifest.json').read_bytes())
        self.f.save()
        with self.assertRaises(DeliveryError):
            validate_packet(self.f.packet_path, self.root)

    def test_evidence_changed_after_hash_check_is_rejected(self):
        import preflight
        original_read = preflight.read_json
        self.f.result['tests_sha256'] = '0' * 64
        write_json(self.f.bundle / 'result.json', self.f.result)
        self.f.packet['test_results'][0]['sha256'] = digest((self.f.bundle / 'result.json').read_bytes())
        self.f.save()

        def replace_before_read(path, *args, **kwargs):
            if pathlib.Path(path).name == 'result.json':
                self.f.result['tests_sha256'] = digest(json.dumps(self.f.tests,
                    sort_keys=True, separators=(',', ':')).encode())
                write_json(pathlib.Path(path), self.f.result)
            return original_read(path, *args, **kwargs)

        with patch('preflight.read_json', side_effect=replace_before_read):
            with self.assertRaises(DeliveryError):
                validate_packet(self.f.packet_path, self.root)


if __name__ == '__main__':
    unittest.main()
