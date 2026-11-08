"""Exact source review and finite policy; target projection never writes the target."""
from pathlib import Path
import re
import tempfile

from preflight import (DeliveryError, canonical, checked_path, git, git_file, hash_value,
                       pinned, private_git, read_json, require, sha, source_path, utc)

REVIEWER_THREAD = '01a15c3d-8ef3-7452-a7b2-88e4e018a482'
DIFF_ARGS = ('--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=3')


def load_scope_policy(path, expected_sha, root):
    path = pinned(root, dict(path=str(path), sha256=expected_sha), root)
    policy = read_json(path, expected_sha)
    require(isinstance(policy, dict), 'invalid standing policy object')
    require(policy.get('schema_version') == 1 and policy.get('mode') == 'standing_scope'
            and policy.get('writer') == 13, 'invalid standing policy')
    require(isinstance(policy.get('approval_id'), str) and policy['approval_id'], 'missing approval identity')
    require(isinstance(policy.get('trial_id'), str) and policy['trial_id']
            and policy.get('event_scope') in ('preparation', 'product'), 'invalid policy event context')
    require(utc(policy['valid_from']) < utc(policy['expires_at']), 'invalid policy validity window')
    require(hash_value(policy.get('guard_profile_sha256')), 'missing guard profile identity')
    require(Path(policy['target_repo']).is_absolute(), 'standing target must be absolute')
    checked_path(path.parent, policy['target_repo'], root)
    reviewer = policy.get('reviewer', {})
    require(reviewer.get('number') == 14 and reviewer.get('thread_id') == REVIEWER_THREAD,
            'invalid designated reviewer identity')
    require(Path(reviewer['report_root']).is_absolute(), 'reviewer report root must be absolute')
    checked_path(path.parent, reviewer['report_root'], root)
    scopes = policy.get('task_scopes')
    require(isinstance(scopes, list) and scopes, 'empty standing scope')
    seen = set()
    for scope in scopes:
        require(isinstance(scope, dict) and type(scope.get('task_owner')) is int
                and 1 <= scope['task_owner'] <= 20 and isinstance(scope.get('task_id'), str)
                and scope['task_id'] and scope.get('source_class') in ('new_development', 'inherited_wip'),
                'invalid task scope')
        identity = scope['task_owner'], scope['task_id']
        require(identity not in seen, 'duplicate task scope')
        seen.add(identity)
        paths = scope.get('allowed_paths')
        require(isinstance(paths, list) and paths and all(isinstance(p, str)
                and not any(c in p for c in '*?[]') and source_path(p) == p for p in paths)
                and len({p.casefold() for p in paths}) == len(paths), 'invalid finite task paths')
    return policy


def scope_context(policy, task_owner, task_id, paths, *, producer=None, ac_ids=()):
    require(type(task_owner) is int and isinstance(task_id, str), 'invalid task identity')
    matches = [s for s in policy['task_scopes'] if (s['task_owner'], s['task_id']) == (task_owner, task_id)]
    require(len(matches) == 1, 'task is outside standing scope')
    scope = matches[0]
    require(set(paths).issubset(scope['allowed_paths']), 'source is outside standing task paths')
    require(producer is None or producer in (task_owner, 13), 'producer is outside task ownership')
    require(set(ac_ids).issubset(scope.get('ac_ids', [task_id])), 'AC is outside standing task scope')
    return dict(trial_id=policy['trial_id'], task_owner=task_owner, task_id=task_id,
                source_class=scope['source_class'], event_scope=policy['event_scope'])


def source_identity(packet, manifest):
    fields = ('path', 'base_blob', 'candidate_blob', 'candidate_sha256')
    return dict(version=2, producer_owner=packet['owner'],
        **{k: packet.get(k) for k in ('trial_id', 'task_owner', 'task_id', 'source_class', 'event_scope')},
        ac_ids=packet['ac_ids'], dependencies=packet['dependencies'], tests=packet['tests'],
        lock_hashes=packet['lock_hashes'], patch_sha256=manifest['forward_sha256'],
        files=[{k: f.get(k) for k in fields} for f in sorted(manifest['files'], key=lambda f: f['path'])])


def application_key(packet, manifest):
    identity = source_identity(packet, manifest)
    return sha(canonical({k: identity[k] for k in ('patch_sha256', 'files')}))


def source_key(packet, manifest):
    return sha(canonical(source_identity(packet, manifest)))


def validate_source_review(packet, manifest, review, review_path, policy, root):
    require(policy is not None and packet.get('delivery_kind') == 'local_source_only',
            'source review v2 requires approved local standing scope')
    context = scope_context(policy, packet.get('task_owner'), packet.get('task_id'),
        [f['path'] for f in manifest['files']], producer=packet['owner'], ac_ids=packet['ac_ids'])
    require(all(packet.get(k) == v for k, v in context.items()), 'standing source context mismatch')
    review_root = checked_path(root, policy['reviewer']['report_root'], root)
    require(Path(review_path).is_relative_to(review_root), 'review outside designated reviewer report root')
    key = source_key(packet, manifest)
    require(packet.get('source_binding_sha256') == key and review.get('source_review_version') == 2
            and review.get('reviewer') == 14 and review.get('reviewer_thread_id') == REVIEWER_THREAD
            and review.get('disposition') == 'ACCEPT'
            and review.get('task_owner') == packet['task_owner'] and review.get('task_id') == packet['task_id']
            and review.get('source_binding_sha256') == key, 'exact source review binding mismatch')
    return key


def patch_operations(data):
    # Ignore only Git object IDs and hunk line offsets, never source/context/mode bytes.
    result = []
    for line in data.split(b'\n'):
        if line.startswith(b'index '):
            result.append(b'index' + (b' ' + line.split()[2] if len(line.split()) == 3 else b''))
        elif line.startswith(b'@@ '):
            result.append(re.sub(rb'^@@ -[0-9]+(?:,[0-9]+)? \+[0-9]+(?:,[0-9]+)? @@', b'@@', line))
        else:
            result.append(line)
    return sha(b'\n'.join(result))


def project_target(packet, manifest, policy, root, scratch):
    target = checked_path(root, packet['target_repo'], root)
    require(target == checked_path(root, policy['target_repo'], root), 'wrong standing target')
    require(not git(target, 'status', '--porcelain=v1').strip(), 'standing target is dirty')
    base = git(target, 'rev-parse', 'HEAD').decode().strip()
    original = checked_path(root, packet['repo'], root)
    manifest_dir = checked_path(root, packet['_manifest_directory'], root)
    patch = pinned(manifest_dir, dict(path='forward.patch', sha256=manifest['forward_sha256']), root)
    raw = patch.read_bytes()
    Path(scratch).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch, prefix='target-projection-') as directory:
        repo = private_git(Path(directory), (original, target), root)
        index = Path(directory) / 'index'
        frozen = Path(directory) / 'source.patch'
        frozen.write_bytes(raw)
        git(repo, 'read-tree', base, index=index)
        try:
            git(repo, 'apply', '--cached', '--check', '--whitespace=nowarn', str(frozen), index=index)
            git(repo, 'apply', '--cached', '--whitespace=nowarn', str(frozen), index=index)
        except DeliveryError as error:
            raise DeliveryError('target composition overlaps or requires incremental review: ' + str(error)) from error
        tree = git(repo, 'write-tree', index=index).decode().strip()
        paths = git(repo, 'diff', '--name-only', '-z', base, tree).decode().strip('\0').split('\0')
        require(set(paths) == {f['path'] for f in manifest['files']}, 'target composition changed path set')
        delta = git(repo, 'diff', *DIFF_ARGS, base, tree)
        require(patch_operations(delta) == patch_operations(raw), 'new composition hunks require incremental review')
        for group in ('tests', 'lock_hashes'):
            for path, expected in packet[group].items():
                _, data = git_file(repo, tree, path)
                require(data is not None and sha(data) == expected, 'target test/lock drift requires incremental review')
    require(git(target, 'rev-parse', 'HEAD').decode().strip() == base
            and not git(target, 'status', '--porcelain=v1').strip(), 'target CAS changed during projection')
    return dict(target_base=base, target_tree=tree, target_delta_sha256=sha(delta))
