"""Freeze finite local source against the actual target; never run tests, merge, or authorize a runner."""
import argparse
import datetime as dt
import json
from pathlib import Path
import tempfile

from preflight import (DeliveryError, canonical, checked_path, git, git_file, pinned,
                       read_json, require, sha, source_path, validate_packet, hash_value, r3_task, private_git)


def _paths(values):
    result = [source_path(p) for p in values]
    require(len(result) == len(set(p.casefold() for p in result)), 'duplicate source path')
    return result


def _bytes(repo, name, root):
    raw_path = Path(repo) / name
    path = checked_path(repo, name, root)
    # Junctions are reparse points too; Path.is_symlink alone does not cover them on Windows.
    require(not any(getattr(p.lstat(), 'st_file_attributes', 0) & 0x400
                    for p in (raw_path, *raw_path.parents) if p.exists()), 'reparse input refused')
    require(path.is_file(), 'only regular source files are accepted')
    raw = path.read_bytes()
    try:
        raw.decode('utf-8')
        content = raw.replace(b'\r\n', b'\n') if b'\0' not in raw else raw
    except UnicodeDecodeError:
        content = raw
    return raw, content


def authorize_freeze(owner, repo, target, output):
    # Loaded from the reviewed release import closure, never a CLI module path.
    import workspace_guard
    require(hasattr(workspace_guard, 'load_r3_config') and hasattr(workspace_guard, 'check_r3'),
            'reviewed R3 guard is required')
    config, error = workspace_guard.load_r3_config()
    require(error is None, 'R3 identity configuration unavailable')
    entries = [w for w in config['assignments']['workers'] if w.get('number') == owner]
    require(len(entries) == 1, 'unknown R3 author')
    private = Path(entries[0]['private_workspace']).resolve()
    report = Path(entries[0]['report_directory']).resolve()
    require(repo.is_relative_to(private) and Path.cwd().resolve() == repo, 'source does not match actual author cwd')
    require(output.is_relative_to(private) or output.is_relative_to(report), 'freeze must write only author private/report scope')
    require(target == Path(config['policy']['shared_integration']).resolve(), 'target is not the fixed shared baseline')
    require(workspace_guard.check_r3(owner, str(output)).get('allowed') is True, 'R3 author/output guard denied')
    from preflight import R3_PROFILE_SHA
    return dict(owner=owner, source_repo=str(repo), output=str(output), profile_sha256=R3_PROFILE_SHA,
                timestamp_basis='process_observed', permission_issued=False)


def freeze(*, repo, base, target, output, root, packet_id, owner, paths, tests, locks,
           wip_baseline=None, task_owner=None, task_id=None):
    root = Path(root).resolve()
    repo, target = [checked_path(root, p, root) for p in (repo, target)]
    output = checked_path(root, output, root)
    require(not output.exists(), 'freeze output already exists')
    context = r3_task(task_owner, task_id, root) if task_owner is not None or task_id is not None else {}
    require(type(owner) is int and 1 <= owner <= 20, 'invalid owner')
    author_binding = authorize_freeze(owner, repo, target, output)
    import re
    require(isinstance(packet_id, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', packet_id), 'invalid packet ID')
    paths, tests, locks = _paths(paths), _paths(tests), _paths(locks)
    require(paths and tests, 'finite source and test paths required')
    for workspace in (repo, target):
        require(Path(git(workspace, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == workspace,
                'explicit Git root required')
        checked_path(workspace, git(workspace, 'rev-parse', '--git-common-dir').decode().strip(), root)
    require(not git(target, 'status', '--porcelain=v1').strip(), 'target is not clean')
    source_base = git(repo, 'rev-parse', base + '^{commit}').decode().strip()
    target_base = git(target, 'rev-parse', 'HEAD').decode().strip()
    source_head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    status = git(repo, 'status', '--porcelain=v1', '-z')
    baseline = {}
    if wip_baseline is not None:
        baseline = read_json(pinned(repo, wip_baseline, root), wip_baseline['sha256'])
        require(isinstance(baseline, dict) and isinstance(baseline.get('files'), dict), 'invalid WIP baseline')
        baseline = baseline['files']
        require(all(source_path(p) == p and hash_value(h) for p, h in baseline.items()), 'invalid WIP file pins')
    selected = {}
    for name in paths:
        path = checked_path(repo, name, root)
        raw, content = _bytes(repo, name, root) if path.exists() else (None, None)
        old_blob, old_data = git_file(repo, source_base, name)
        if content is not None and old_data is not None and b'\0' not in content and b'\r\n' in old_data:
            content = content.replace(b'\n', b'\r\n')
        selected[name] = raw, content
        require(path.exists() or old_blob is not None, 'missing source preimage')
    # Pins identify the actual files supplied for verification, not a claim those tests passed.
    test_bytes = {name: _bytes(repo, name, root) for name in set(tests + locks)}
    output.mkdir(parents=True)
    (output / 'source-status.bin').write_bytes(status)
    object_repo = private_git(output, (repo, target), root)
    alternates_path = object_repo / 'objects/info/alternates'
    with tempfile.TemporaryDirectory(dir=output, prefix='index-') as temp:
        source_index, target_index = Path(temp) / 'source', Path(temp) / 'target'
        git(object_repo, 'read-tree', source_base, index=source_index)
        for name, (_, data) in selected.items():
            if data is None:
                git(object_repo, 'update-index', '--force-remove', '--', name, index=source_index)
            else:
                record = git(object_repo, 'ls-tree', source_base, '--', name).decode().split()
                mode = record[0] if record else '100644'
                require(mode in ('100644', '100755'), 'only regular Git files accepted')
                blob = git(object_repo, 'hash-object', '-w', '--stdin', input_bytes=data).decode().strip()
                git(object_repo, 'update-index', '--add', '--cacheinfo', mode, blob, name, index=source_index)
        source_tree = git(object_repo, 'write-tree', index=source_index).decode().strip()
        source_patch = git(object_repo, 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-renames',
                           source_base, source_tree, '--', *paths)
        (output / 'author.patch').write_bytes(source_patch)
        git(object_repo, 'read-tree', target_base, index=target_index)
        git(object_repo, 'apply', '--cached', '--check', '--whitespace=nowarn', str(output / 'author.patch'), index=target_index)
        git(object_repo, 'apply', '--cached', '--whitespace=nowarn', str(output / 'author.patch'), index=target_index)
        tree = git(object_repo, 'write-tree', index=target_index).decode().strip()
        changed = git(object_repo, 'diff', '--name-only', '-z', target_base, tree).decode().strip('\0').split('\0')
        require(set(changed) == set(paths), 'selected paths must be the exact nonempty target delta')
        for name, expected in list(test_bytes.items()):
            _, actual = git_file(object_repo, tree, name)
            require(actual is not None and actual in expected, 'test/lock is not the same target source: ' + name)
            test_bytes[name] = actual
        # This writes an immutable object only; no branch, worktree, or real index is changed.
        commit = git(object_repo, '-c', 'user.name=Local Source Freeze', '-c', 'user.email=source-freeze@local.invalid',
                     'commit-tree', tree, '-p', target_base, '-m', 'Local source-only freeze ' + packet_id).decode().strip()
    git(object_repo, 'update-ref', 'refs/heads/frozen', commit)
    files = []
    for name in paths:
        old, _ = git_file(object_repo, target_base, name)
        blob, data = git_file(object_repo, commit, name)
        raw, _ = selected[name]
        snapshot = 'source/' + name if data is not None else None
        if snapshot:
            path = output / snapshot
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        raw_sha = sha(raw) if raw is not None else None
        files.append(dict(path=name, base_blob=old, candidate_blob=blob, snapshot=snapshot,
                          candidate_sha256=sha(data) if data is not None else None, source_raw_sha256=raw_sha,
                          wip_attribution=('inherited_unchanged' if baseline[name] == raw_sha else 'changed_since_baseline')
                          if name in baseline else 'unknown'))
    manifest = dict(base_commit=target_base, candidate_commit=commit, target_tree=tree,
                    source_base_commit=source_base, source_head=source_head, source_repo=str(repo),
                    source_status_sha256=sha(status), wip_baseline=wip_baseline, files=files,
                    alternates_sha256=sha(alternates_path.read_bytes()), author_binding=author_binding)
    for name, left, right in [('forward', target_base, commit), ('reverse', commit, target_base)]:
        data = git(object_repo, 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-renames', left, right)
        (output / (name + '.patch')).write_bytes(data)
        manifest[name + '_sha256'] = sha(data)
    (output / 'manifest.json').write_bytes(canonical(manifest) + b'\n')
    require(git(target, 'rev-parse', 'HEAD').decode().strip() == target_base
            and not git(target, 'status', '--porcelain=v1').strip(), 'target moved while freezing')
    require(git(repo, 'rev-parse', 'HEAD').decode().strip() == source_head
            and git(repo, 'status', '--porcelain=v1', '-z') == status, 'source changed while freezing')
    for name, (raw, _) in selected.items():
        path = checked_path(repo, name, root)
        require((_bytes(repo, name, root)[0] if path.exists() else None) == raw, 'source bytes changed while freezing')
    ready = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
    packet = dict(schema_version=1, delivery_kind='local_source_only', scope='local_source', packet_id=packet_id,
                  owner=owner, next_owner=13, ac_ids=[], dependencies=[], repo=str(object_repo), target_repo=str(target),
                  candidate_commit=commit, tree=tree, manifest_path='manifest.json',
                  manifest_sha256=sha((output / 'manifest.json').read_bytes()),
                  tests={p: sha(test_bytes[p]) for p in tests}, lock_hashes={p: sha(test_bytes[p]) for p in locks},
                  test_results=[], review=None, ready_at=ready, source_class='inherited_wip',
                  runner_execution_authorized=False)
    packet.update(context)
    packet_path = output / 'packet.json'
    draft = output / 'packet.pending.json'
    draft.write_bytes(canonical(packet) + b'\n')
    validate_packet(draft, root, scratch_root=output / 'checks')
    draft.rename(packet_path)
    (output / 'ready-event.json').write_bytes(canonical(dict(schema_version=1, event_type='ready',
        event_scope='product' if context else 'preparation',
        event_id=sha(packet_path.read_bytes()), occurred_at=ready, ready_at=ready, timestamp_basis='process_observed',
        timestamp_provenance=dict(basis='process_observed', process_observed_at=ready, actor_reported_at=None, native_observed_at=None),
        owner=str(owner), packet_id=packet_id,
        candidate_commit=commit, candidate_tree=tree, manifest_path=str(output / 'manifest.json'),
        manifest_sha256=packet['manifest_sha256'], **dict(context, source_class=packet['source_class']))) + b'\n')
    return packet_path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'base', 'target', 'output', 'root', 'packet-id'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--owner', required=True, type=int)
    parser.add_argument('--path', action='append', required=True, dest='paths')
    parser.add_argument('--test', action='append', required=True, dest='tests')
    parser.add_argument('--lock', action='append', default=[], dest='locks')
    parser.add_argument('--task-owner', type=int)
    parser.add_argument('--task-id')
    parser.add_argument('--wip-baseline')
    parser.add_argument('--wip-baseline-sha')
    args = vars(parser.parse_args())
    baseline_sha = args.pop('wip_baseline_sha')
    if args['wip_baseline']:
        args['wip_baseline'] = dict(path=args['wip_baseline'], sha256=baseline_sha)
    try:
        print(json.dumps(dict(ok=True, packet=str(freeze(**args)), runner_execution_authorized=False)))
    except (DeliveryError, OSError, ValueError) as error:
        print(json.dumps(dict(ok=False, error=str(error))))
        raise SystemExit(1)
