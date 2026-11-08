"""Validate a frozen packet. Never execute its commands or change its Git index."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import zipfile

from linux_run import verify_and_extract_source
from result_validate import load_schema, validate_job_result, validate_test_event


class DeliveryError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise DeliveryError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def utc(value):
    require(isinstance(value, str) and value.endswith('Z'), 'UTC time must end in Z')
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError as error:
        raise DeliveryError('invalid UTC time') from error
    require('T' in value and parsed.utcoffset() == dt.timedelta(0), 'invalid UTC time')
    return parsed


def oid(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{40}', value) is not None


def hash_value(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def source_path(value):
    require(isinstance(value, str) and value and '\\' not in value and ':' not in value,
            'invalid source path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and path.as_posix() == value and not any(p in ('.', '..') for p in path.parts),
            'noncanonical source path')
    require(not any(p.lower() in ('.git', '.ssh', '.aws') or p.lower().startswith('.env') for p in path.parts),
            'credential or Git-internal path is not a delivery input')
    return value


def checked_path(base, value, root):
    require(isinstance(value, (str, Path)) and str(value), 'missing file path')
    raw = Path(value) if Path(value).is_absolute() else Path(base) / value
    path = raw.resolve()
    require(path.is_relative_to(root), 'path escapes allowed root')
    require(not any(p.is_symlink() for p in (raw, *raw.parents) if p != root.parent), 'symlink input refused')
    require(not any(p.lower() in ('.ssh', '.aws') or p.lower().startswith('.env') for p in path.parts),
            'credential path refused')
    return path


def read_json(path, expected_sha=None):
    try:
        raw = Path(path).read_bytes()
        if expected_sha is not None:
            require(sha(raw) == expected_sha, 'JSON changed after its identity check')
        return json.loads(raw.decode('utf-8-sig'))
    except (ValueError, OSError) as error:
        raise DeliveryError('cannot read JSON: ' + str(path)) from error


def pinned(base, reference, root):
    require(isinstance(reference, dict) and hash_value(reference.get('sha256')), 'missing evidence hash')
    path = checked_path(base, reference.get('path'), root)
    require(path.is_file() and sha(path.read_bytes()) == reference['sha256'], 'file hash mismatch: ' + str(path))
    return path


def git(repo, *args, index=None, input_bytes=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env['GIT_OPTIONAL_LOCKS'] = '0'
    if index:
        env['GIT_INDEX_FILE'] = str(index)
    result = subprocess.run(['git', '-c', 'core.autocrlf=false', *args], cwd=repo, env=env,
                            input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    require(result.returncode == 0, 'git check failed: ' + ' '.join(args[:2]))
    return result.stdout


def private_git(directory, repositories, root):
    """Own all new objects; alternates only read existing source/base objects."""
    directory = checked_path(root, directory, root)
    repo = directory / 'repo.git'
    git(directory, 'init', '--quiet', '--bare', str(repo))
    alternates = sorted({checked_path(source, git(source, 'rev-parse', '--git-path', 'objects').decode().strip(), root).as_posix()
                         for source in repositories})
    (repo / 'objects/info/alternates').write_bytes(('\n'.join(alternates) + '\n').encode('utf-8'))
    return repo


def git_file(repo, commit, path):
    records = git(repo, 'ls-tree', '-z', commit, '--', source_path(path)).split(b'\0')
    records = [r for r in records if r]
    if not records:
        return None, None
    require(len(records) == 1, 'ambiguous Git path')
    metadata, name = records[0].split(b'\t', 1)
    mode, kind, blob = metadata.decode().split()
    require(name.decode('utf-8') == path and kind == 'blob' and mode in ('100644', '100755'),
            'only regular Git files are accepted')
    return blob, git(repo, 'cat-file', 'blob', blob)


R3_PROFILE_PATH = Path('E:/codex/yunticket/docs/diagnostics/delivery-flow-v3-20261025/runtime-profile.json')
R3_PROFILE_SHA = 'af095aac34ce65a2d40b224a6ab500c8a9810a00b8c48b9f570bd7912eb130b1'


def r3_task(task_owner, task_id, root):
    """Resolve task attribution from R's fixed immutable START, never a caller map."""
    require(type(task_owner) is int and 1 <= task_owner <= 20 and isinstance(task_id, str), 'invalid R3 task')
    root = Path(root).resolve()
    path = checked_path(root, R3_PROFILE_PATH, root)
    profile = read_json(path, R3_PROFILE_SHA)
    require(isinstance(profile, dict) and all(k in profile for k in ('profile_id', 'trial_start_pin', 'trial_start_snapshot')), 'invalid R3 profile')
    pin_path = checked_path(path.parent, profile['trial_start_pin'], root)
    snapshot_path = checked_path(path.parent, profile['trial_start_snapshot'], root)
    pin = read_json(pin_path)
    require(isinstance(pin, dict), 'invalid R3 start pin')
    require(pin.get('schema') == 'jot.r3.trial-start-pin.v1' and pin.get('immutable') is True
            and pin.get('trial_id') == profile['profile_id']
            and checked_path(path.parent, pin.get('snapshot_path'), root) == snapshot_path
            and hash_value(pin.get('snapshot_sha256')), 'invalid R3 start pin')
    snapshot = read_json(snapshot_path, pin.get('snapshot_sha256'))
    require(isinstance(snapshot, dict) and snapshot.get('schema') == 'jot.r3.trial-start-snapshot.v1'
            and snapshot.get('trial_id') == pin['trial_id']
            and snapshot.get('trial', {}).get('started') is True
            and snapshot['trial'].get('real_product_trial_started') is True, 'R3 has not started')
    orders = snapshot.get('work_orders')
    require(isinstance(orders, list) and all(isinstance(o, dict) for o in orders), 'R3 work orders missing')
    matches = [order for order in orders if type(order.get('worker')) is int and order.get('worker') == task_owner]
    require(len(matches) == 1, 'R3 task owner missing or duplicated')
    order = matches[0]
    require(task_id in (order.get('primary_id'), order.get('backup_id')), 'task is outside pinned work order')
    expected = path.parent / ('worker-%02d' % task_owner) / 'work-order.json'
    require(checked_path(path.parent, order.get('work_order_path'), root) == expected.resolve()
            and hash_value(order.get('work_order_sha256')), 'unexpected R3 work-order path')
    original = read_json(checked_path(path.parent, expected, root), order.get('work_order_sha256'))
    require(isinstance(original, dict) and original.get('source_class_by_task') == order.get('source_class_by_task'), 'R3 task classification changed')
    source_class = order.get('source_class_by_task', {}).get(task_id)
    require(source_class in ('new_development', 'inherited_wip'), 'missing R3 task classification')
    return dict(trial_id=pin['trial_id'], task_owner=task_owner, task_id=task_id, source_class=source_class)


def validate_packet(packet_path, root, *, scratch_root=None, scope_policy=None, review_reference=None):
    root = Path(root).resolve()
    require(root.is_dir(), 'allowed root does not exist')
    packet_path = checked_path(root, packet_path, root)
    packet_sha = sha(packet_path.read_bytes())
    packet = read_json(packet_path, packet_sha)
    require(isinstance(packet, dict), 'invalid packet object')
    local = packet.get('delivery_kind') == 'local_source_only'
    require(packet.get('delivery_kind') in (None, 'local_source_only'), 'unknown delivery kind')
    required = ('schema_version', 'packet_id', 'owner', 'ac_ids', 'repo', 'candidate_commit', 'tree',
                'manifest_path', 'manifest_sha256', 'dependencies', 'tests', 'lock_hashes', 'test_results',
                'review', 'next_owner', 'ready_at', 'source_class')
    if not local:
        required += ('source_archive', 'source_manifest')
    require(isinstance(packet, dict) and all(k in packet for k in required), 'missing packet identity')
    require(packet['schema_version'] == 1 and isinstance(packet['packet_id'], str)
            and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', packet['packet_id']), 'invalid packet ID')
    for key in ('owner', 'next_owner'):
        require(type(packet[key]) is int and 1 <= packet[key] <= 20, 'invalid owner')
    for key in ('ac_ids', 'dependencies'):
        value = packet[key]
        require(isinstance(value, list) and all(isinstance(v, str) and v for v in value)
                and len(set(value)) == len(value), 'invalid ' + key)
    require(packet['source_class'] in ('inherited_wip', 'new_development'), 'invalid source class')
    utc(packet['ready_at'])
    if packet.get('trial_id') == 'jot-parallel-r3-20261025' or any(k in packet for k in ('task_owner', 'task_id')):
        if scope_policy is not None and packet.get('trial_id') != 'jot-parallel-r3-20261025':
            from source_binding import scope_context
            context = scope_context(scope_policy, packet.get('task_owner'), packet.get('task_id'), [],
                                    producer=packet['owner'], ac_ids=packet['ac_ids'])
        else:
            context = r3_task(packet.get('task_owner'), packet.get('task_id'), root)
        require(all(packet.get(k) == v for k, v in context.items()), 'R3 packet attribution mismatch')
    require(oid(packet['candidate_commit']) and oid(packet['tree']), 'unfixed Git identity')
    repo = checked_path(packet_path.parent, packet['repo'], root)
    common = git(repo, 'rev-parse', '--git-common-dir').decode().strip()
    checked_path(repo, common, root)
    manifest_path = pinned(packet_path.parent,
        dict(path=packet['manifest_path'], sha256=packet['manifest_sha256']), root)
    manifest = read_json(manifest_path, packet['manifest_sha256'])
    require(isinstance(manifest, dict), 'invalid manifest object')
    if local:
        require(repo == (manifest_path.parent / 'repo.git').resolve(), 'local object database is not private')
        alternates = repo / 'objects/info/alternates'
        require(sha(alternates.read_bytes()) == manifest.get('alternates_sha256'), 'local alternates changed')
        for alternate in alternates.read_text(encoding='utf-8').splitlines():
            require(checked_path(repo, alternate, root).is_dir(), 'invalid read-only alternate')
        binding = manifest.get('author_binding', {})
        require(binding.get('owner') == packet['owner'] and binding.get('source_repo') == manifest.get('source_repo')
                and binding.get('output') == str(manifest_path.parent)
                and binding.get('profile_sha256') == (scope_policy['guard_profile_sha256']
                    if scope_policy is not None else R3_PROFILE_SHA), 'local author identity mismatch')
        checked_path(packet_path.parent, packet.get('target_repo'), root)
    base = manifest.get('base_commit')
    require(oid(base) and manifest.get('candidate_commit') == packet['candidate_commit']
            and manifest.get('target_tree') == packet['tree'], 'manifest source mismatch')
    commit = packet['candidate_commit']
    require(git(repo, 'cat-file', '-t', commit).strip() == b'commit', 'candidate is not a commit')
    require(git(repo, 'rev-parse', commit + '^{tree}').decode().strip() == packet['tree'], 'tree mismatch')
    git(repo, 'merge-base', '--is-ancestor', base, commit)
    files = manifest.get('files')
    require(isinstance(files, list) and files, 'missing exact file list')
    paths = [source_path(f.get('path')) for f in files if isinstance(f, dict)]
    require(len(paths) == len(files) and len(set(p.casefold() for p in paths)) == len(paths), 'duplicate path')
    changed = git(repo, 'diff', '--name-only', '-z', base, commit).decode().strip('\0').split('\0')
    require(set(paths) == set(changed), 'manifest does not match exact changed paths')
    for entry in files:
        path = entry['path']
        old_blob, _ = git_file(repo, base, path)
        blob, data = git_file(repo, commit, path)
        require(entry.get('base_blob') == old_blob and entry.get('candidate_blob') == blob,
                'Git preimage/postimage mismatch: ' + path)
        if blob is None:
            require(entry.get('snapshot') is None and entry.get('candidate_sha256') is None, 'deleted path has content')
            continue
        snapshot = pinned(manifest_path.parent,
                          dict(path=entry.get('snapshot'), sha256=entry.get('candidate_sha256')), root)
        raw = snapshot.read_bytes()
        require(sha(raw) == entry['candidate_sha256'], 'snapshot changed after its identity check')
        if raw != data:
            try:
                raw.decode('utf-8')
            except UnicodeDecodeError as error:
                raise DeliveryError('binary snapshot differs from Git') from error
            require(b'\0' not in raw and raw.replace(b'\r\n', b'\n') == data, 'snapshot differs from Git')
    require(isinstance(packet['tests'], dict) and packet['tests'], 'test identity is required')
    for key in ('tests', 'lock_hashes'):
        require(isinstance(packet[key], dict), 'invalid ' + key)
        for path, expected in packet[key].items():
            _, content = git_file(repo, commit, source_path(path))
            require(hash_value(expected) and content is not None and sha(content) == expected, key + ' mismatch')
    tests_sha = sha(canonical(packet['tests']))
    if local:
        require(packet.get('scope') == 'local_source' and packet['test_results'] == []
                and packet.get('runner_execution_authorized') is False, 'invalid local source boundary')
        require(git(repo, 'rev-parse', commit + '^').decode().strip() == base, 'local target parent mismatch')
    else:
        archive_path = pinned(packet_path.parent, packet['source_archive'], root)
        source_manifest_path = pinned(packet_path.parent, packet['source_manifest'], root)
        temp_root = root / '.test-tmp'
        temp_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temp_root, prefix='source-check-') as directory:
            frozen = Path(directory)
            for path, ref, name in [(archive_path, packet['source_archive'], 'source.zip'),
                                    (source_manifest_path, packet['source_manifest'], 'source-manifest.json')]:
                raw = path.read_bytes()
                require(sha(raw) == ref['sha256'], 'source input changed after its identity check')
                (frozen / name).write_bytes(raw)
            info = verify_and_extract_source(frozen / 'source.zip', frozen / 'source-manifest.json',
                frozen / 'work', packet['tests'], packet['source_manifest']['sha256'], commit,
                packet['tree'], packet['lock_hashes'])
            require(info['archive_sha256'] == packet['source_archive']['sha256'], 'archive identity mismatch')
            git_paths = git(repo, 'ls-tree', '-r', '--name-only', '-z', commit).decode().strip('\0').split('\0')
            require(set(info['files']) == set(git_paths), 'archive must cover the exact candidate Git tree')
            for path, expected in info['files'].items():
                _, content = git_file(repo, commit, path)
                require(content is not None and sha(content) == expected, 'archive differs from candidate Git file: ' + path)
        require(isinstance(packet['test_results'], list) and packet['test_results'], 'test evidence required')
        for ref in packet['test_results']:
            result_path = pinned(packet_path.parent, ref, root)
            result = read_json(result_path, ref['sha256'])
            require(isinstance(result, dict) and isinstance(result.get('source'), dict), 'invalid test result')
            source = result.get('source', {})
            require(result.get('status') == 'PASS' and type(result.get('exit_code')) is int and result['exit_code'] == 0,
                    'required fast check did not pass')
            require(source.get('commit') == commit and source.get('tree') == packet['tree']
                    and source.get('package_sha256') == packet['source_archive']['sha256']
                    and source.get('lock_sha256') == packet['lock_hashes'], 'test result source mismatch')
            require(result.get('tests_sha256') == tests_sha and isinstance(result.get('command'), list)
                    and result['command'] and all(isinstance(v, str) for v in result['command']), 'test suite identity mismatch')
            context, artifacts = result.get('event_context'), result.get('artifacts')
            require(isinstance(context, dict) and isinstance(artifacts, dict), 'missing result context/artifacts')
            require(context.get('manifest_path') == packet['manifest_path']
                    and context.get('manifest_sha256') == packet['manifest_sha256']
                    and context.get('candidate_commit') == commit and context.get('candidate_tree') == packet['tree']
                    and context.get('packet_id') == packet['packet_id'] and context.get('owner') == str(packet['owner']),
                    'result packet context mismatch')
            require(result.get('repo') == packet['repo'] and result.get('tests') == packet['tests'], 'result repo/tests mismatch')
            require(artifacts.get('source_manifest_sha256') == packet['source_manifest']['sha256'],
                    'result source manifest mismatch')
            for name, expected in [('source_archive', packet['source_archive']['sha256']),
                                   ('source_manifest', packet['source_manifest']['sha256'])]:
                pinned(result_path.parent, dict(path=artifacts.get(name), sha256=expected), root)
            if result.get('evidence_kind') == 'authoring_host':
                require(packet.get('scope') == 'synthetic' and not packet['ac_ids']
                        and 'environment' not in result, 'authoring simulation is only synthetic evidence')
            else:
                require(result.get('environment', {}).get('os') == 'linux', 'Linux result environment required')
                require(all(context.get(k) == packet[k] for k in ('source_class', 'dependencies', 'ac_ids', 'ready_at'))
                        and context.get('next_owner') == str(packet['next_owner']), 'Linux event routing context mismatch')
                errors = validate_job_result(result, load_schema(Path(__file__).with_name('linux-job-result.schema.json')),
                                             result_path.parent)
                require(not errors, 'invalid Linux result: ' + '; '.join(errors))
                event_path = checked_path(result_path.parent, artifacts.get('event_draft'), root)
                lines = event_path.read_text(encoding='utf-8').splitlines()
                require(len(lines) == 1, 'exactly one Linux event draft required')
                errors = validate_test_event(json.loads(lines[0]), result, result_path.parent,
                    load_schema(Path(__file__).with_name('test-event.schema.json')))
                require(not errors, 'invalid Linux event: ' + '; '.join(errors))
            require(result.get('formal_acceptance_credit') == 'NONE', 'test evidence must not mint formal credit')
    source_binding_sha = None
    if packet.get('source_binding_sha256') is not None:
        from source_binding import source_key
        source_binding_sha = source_key(packet, manifest)
        require(packet['source_binding_sha256'] == source_binding_sha, 'source binding changed')
    review_status = 'NOT_REVIEWED'
    review_ref = review_reference if review_reference is not None else packet['review']
    if review_ref is not None:
        review_path = pinned(packet_path.parent, review_ref, root)
        review = read_json(review_path, review_ref['sha256'])
        require(isinstance(review, dict), 'invalid review object')
        require(scope_policy is None or review.get('source_review_version') == 2, 'standing scope requires source review v2')
        if review.get('source_review_version') == 2:
            from source_binding import validate_source_review
            source_binding_sha = validate_source_review(packet, manifest, review, review_path, scope_policy, root)
        else:
            require(review.get('reviewer') == 14 and review.get('disposition') == 'ACCEPT'
                    and review.get('candidate_commit') == commit and review.get('tree') == packet['tree']
                    and review.get('manifest_sha256') == packet['manifest_sha256'], 'review source mismatch')
        review_status = 'ACCEPT'
    patches = {}
    for name in ('forward', 'reverse'):
        patches[name] = pinned(manifest_path.parent,
            dict(path=name + '.patch', sha256=manifest.get(name + '_sha256')), root)
    temp_root = checked_path(root, scratch_root or Path.cwd() / '.test-tmp/delivery-local-checks', root) if local else root / '.test-tmp'
    temp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temp_root, prefix='preflight-') as directory:
        index = Path(directory) / 'index'
        verify_repo = private_git(Path(directory), (repo,), root) if local else repo
        for name, path in patches.items():
            data = path.read_bytes()
            require(sha(data) == manifest[name + '_sha256'], 'patch changed after its identity check')
            frozen = Path(directory) / (name + '.patch')
            frozen.write_bytes(data)
            patches[name] = frozen
        git(verify_repo, 'read-tree', base, index=index)
        git(verify_repo, 'apply', '--cached', '--', str(patches['forward']), index=index)
        require(git(verify_repo, 'write-tree', index=index).decode().strip() == packet['tree'], 'forward target mismatch')
        git(verify_repo, 'apply', '--cached', '--', str(patches['reverse']), index=index)
        require(git(verify_repo, 'write-tree', index=index).strip() == git(verify_repo, 'rev-parse', base + '^{tree}').strip(),
                'reverse target mismatch')
    return dict(ok=True, packet_id=packet['packet_id'], packet_sha256=packet_sha,
                candidate_commit=commit, tree=packet['tree'], base_commit=base, paths=sorted(paths),
                manifest_sha256=packet['manifest_sha256'], tests_sha256=tests_sha,
                dependencies=packet['dependencies'], review_status=review_status,
                source_binding_sha256=source_binding_sha,
                source_archive_sha256=packet.get('source_archive', {}).get('sha256'),
                source_manifest_sha256=packet.get('source_manifest', {}).get('sha256'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('packet', type=Path)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--scope-policy', type=Path)
    parser.add_argument('--scope-policy-sha')
    parser.add_argument('--source-review', type=Path)
    parser.add_argument('--source-review-sha')
    args = parser.parse_args()
    try:
        policy = None
        if args.scope_policy:
            from source_binding import load_scope_policy
            policy = load_scope_policy(args.scope_policy, args.scope_policy_sha, args.root)
        review = dict(path=str(args.source_review), sha256=args.source_review_sha) if args.source_review else None
        print(json.dumps(validate_packet(args.packet, args.root, scope_policy=policy, review_reference=review), ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False))
        raise SystemExit(1)
