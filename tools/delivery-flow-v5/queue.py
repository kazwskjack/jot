"""Finite pinned-packet queue; tool-only unless exact paths are approved. Events are state; claims authorize neither runner execution nor Git writes."""
import argparse
from contextlib import contextmanager
import datetime as dt
import json
import os
from pathlib import Path
import uuid

from preflight import (DeliveryError, canonical, checked_path, git, hash_value,
                       pinned, read_json, require, sha, source_path, utc, validate_packet)


@contextmanager
def ledger_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(path.suffix + '.lock').open('a+b') as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise DeliveryError('queue ledger is busy') from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def ordered_entries(plan):
    entries = plan.get('entries')
    require(isinstance(entries, list) and entries, 'empty approved queue')
    by_id = {}
    for entry in entries:
        require(isinstance(entry, dict) and isinstance(entry.get('packet_id'), str)
                and isinstance(entry.get('dependencies'), list) and hash_value(entry.get('sha256')),
                'invalid approved entry')
        require(entry['packet_id'] not in by_id, 'duplicate packet ID')
        require(all(isinstance(v, str) for v in entry['dependencies'])
                and len(set(entry['dependencies'])) == len(entry['dependencies']), 'invalid dependencies')
        by_id[entry['packet_id']] = entry
    result, visiting, visited = [], set(), set()

    def visit(key):
        require(key in by_id, 'dependency outside approved queue')
        require(key not in visiting, 'dependency cycle')
        if key in visited:
            return
        visiting.add(key)
        for dependency in by_id[key]['dependencies']:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)
        result.append(by_id[key])

    for key in by_id:
        visit(key)
    return result


def replay(path):
    history, seen = {}, {}
    if not path.exists():
        return history
    for line in path.read_text(encoding='utf-8').splitlines():
        event = json.loads(line)
        utc(event['occurred_at'])
        require(event.get('schema_version') == 1 and event.get('owner') == '13', 'invalid owner event')
        identity = event['event_id']
        if identity in seen:
            require(seen[identity] == canonical(event), 'conflicting duplicate event ID')
            continue
        seen[identity] = canonical(event)
        action = event.get('queue_action')
        if action is None:
            continue
        require(action in ('claimed', 'integrated', 'failed'), 'unknown queue event')
        key = event['packet_id']
        old = history.get(key)
        if action == 'claimed':
            require(old is None, 'packet was claimed twice')
        else:
            require(old is not None and old['queue_action'] == 'claimed'
                    and old['claim_id'] == event['claim_id'], 'receipt has no original claim')
        history[key] = event
    return history


def advance(plan_path, events_path, root, action, *, packet_id=None, claim_id=None,
            receipt=None, receipt_sha=None, writer=13, now=None, approval_sha=None,
            packet_path=None, packet_sha=None, source_review=None, source_review_sha=None):
    root = Path(root).resolve()
    plan_path = checked_path(root, plan_path, root)
    events_path = checked_path(root, events_path, root)
    require(action in ('status', 'claim', 'record'), 'unknown queue action')
    actual_approval_sha = sha(plan_path.read_bytes())
    plan = read_json(plan_path, actual_approval_sha)
    require(isinstance(plan, dict), 'invalid approved queue')
    standing = plan.get('mode') == 'standing_scope'
    policy = None
    if standing:
        from source_binding import load_scope_policy
        require(approval_sha == actual_approval_sha, 'standing policy approval hash mismatch')
        policy = load_scope_policy(plan_path, approval_sha, root)
    approval_sha = actual_approval_sha
    require(isinstance(plan, dict), 'invalid approved queue')
    require(plan.get('schema_version') == 1 and plan.get('writer') == 13 and type(writer) is int and writer == 13,
            'only the designated writer 13 may operate this queue')
    now = now or dt.datetime.now(dt.timezone.utc)
    require(now.tzinfo is not None, 'queue time must be timezone aware')
    expired = now >= utc(plan['expires_at'])
    require(not expired or action == 'record', 'approved queue expired')
    require(isinstance(plan.get('approval_id'), str) and plan['approval_id'], 'missing approval identity')
    if standing:
        require(now >= utc(plan['valid_from']), 'standing policy is not active')
    else:
        entries = ordered_entries(plan)
    checked_path(root, events_path.with_suffix(events_path.suffix + '.lock'), root)
    with ledger_lock(events_path):
        history = replay(events_path)
        review_ref = dict(path=str(source_review), sha256=source_review_sha) if source_review else None
        if standing:
            if action == 'record':
                old = history.get(packet_id)
                require(old is not None and old['queue_action'] == 'claimed', 'packet has no active claim')
                packet_path, packet_sha = old['source_packet_path'], old['packet_sha256']
                review_ref = old['source_review_ref']
                entries = [dict(packet_id=packet_id, dependencies=old['dependencies'],
                                path=packet_path, sha256=packet_sha)]
            else:
                entries = []
            if action != 'record' and packet_path is not None:
                path = pinned(plan_path.parent, dict(path=str(packet_path), sha256=packet_sha), root)
                source = read_json(path, packet_sha)
                entries = [dict(packet_id=source['packet_id'], dependencies=source['dependencies'],
                                path=str(path), sha256=packet_sha)]
        states, packets, checks, errors = {}, {}, {}, {}
        for entry in entries:
            key = entry['packet_id']
            try:
                path = pinned(plan_path.parent, entry, root)
                check = validate_packet(path, root, scratch_root=events_path.parent / 'delivery-checks',
                    scope_policy=policy, review_reference=review_ref if standing else None)
                require(check['packet_sha256'] == entry['sha256'], 'packet changed during preflight')
                packet = read_json(path, entry['sha256'])
                require(packet['packet_id'] == key and packet['dependencies'] == entry['dependencies'],
                        'approved identity/dependencies changed')
                require(utc(packet['ready_at']) <= now, 'packet is not ready yet')
                tool_only = all(p.startswith('tools/delivery-flow-v1/') for p in check['paths'])
                if standing:
                    from source_binding import scope_context, application_key
                    scope_context(policy, packet.get('task_owner'), packet.get('task_id'), check['paths'],
                                  producer=packet['owner'], ac_ids=packet['ac_ids'])
                    require(check.get('source_binding_sha256') and check['review_status'] == 'ACCEPT',
                            'exact source review is required')
                    require(checked_path(root, packet['target_repo'], root) == checked_path(root, policy['target_repo'], root),
                            'wrong standing target')
                    manifest_path = pinned(path.parent, dict(path=packet['manifest_path'], sha256=packet['manifest_sha256']), root)
                    check['source_application_sha256'] = application_key(packet, read_json(manifest_path, packet['manifest_sha256']))
                    require(not any(e.get('source_application_sha256') == check['source_application_sha256']
                                    and e['packet_id'] != key for e in history.values()), 'duplicate source already consumed')
                elif 'allowed_paths' in entry:
                    allowed = entry['allowed_paths']
                    require(isinstance(allowed, list) and allowed
                            and all(isinstance(p, str) and not any(c in p for c in '*?[]')
                                    and not p.endswith('/') and source_path(p) == p for p in allowed)
                            and len(set(allowed)) == len(allowed)
                            and set(allowed) == set(check['paths']), 'exact allowed paths mismatch')
                else:
                    require(tool_only, 'product packet requires exact allowed paths')
                require(tool_only or check['review_status'] == 'ACCEPT', 'product source review is required')
                if check['review_status'] != 'ACCEPT':
                    require(plan.get('allow_unreviewed_synthetic') is True
                            and tool_only and packet.get('scope') == 'synthetic' and not packet['ac_ids'], 'review is required')
                old = history.get(key)
                if old:
                    require(old['packet_sha256'] == entry['sha256'], 'previously consumed packet identity changed')
                    if old['queue_action'] != 'claimed':
                        saved = pinned(plan_path.parent,
                            dict(path=old['evidence_path'], sha256=old['evidence_sha256']), root)
                        saved_receipt = read_json(saved, old['evidence_sha256'])
                        require(saved_receipt.get('packet_id') == key
                                and saved_receipt.get('status') == old['queue_action']
                                and saved_receipt.get('source_tree' if standing else 'tree') == packet['tree']
                                and saved_receipt.get('candidate_commit') == packet['candidate_commit']
                                and saved_receipt.get('manifest_sha256') == packet['manifest_sha256'],
                                'historical receipt identity changed')
                    states[key] = old['queue_action']
                elif any(states.get(d, history.get(d, {}).get('queue_action')) in ('failed', 'blocked', 'invalid') for d in entry['dependencies']):
                    states[key] = 'blocked'
                elif all(states.get(d, history.get(d, {}).get('queue_action')) == 'integrated' for d in entry['dependencies']):
                    states[key] = 'ready'
                else:
                    states[key] = 'waiting'
                packets[key], checks[key] = packet, check
            except (DeliveryError, OSError, ValueError) as error:
                states[key], errors[key] = 'invalid', str(error)
        if action == 'status':
            return dict(ok=True, states=states, errors=errors, runner_execution_authorized=False)
        if action == 'claim':
            require(not any(e['queue_action'] == 'claimed' for e in history.values()), 'writer has an active claim')
            packet_id = packet_id or next((e['packet_id'] for e in entries if states[e['packet_id']] == 'ready'), None)
            require(packet_id in states and states[packet_id] == 'ready', 'packet is not claimable')
            projection = None
            if standing:
                from source_binding import project_target
                packet = packets[packet_id]
                manifest_path = pinned(Path(packet_path).parent,
                    dict(path=packet['manifest_path'], sha256=packet['manifest_sha256']), root)
                manifest = read_json(manifest_path, packet['manifest_sha256'])
                projection = project_target(dict(packet, _manifest_directory=str(manifest_path.parent)),
                    manifest, policy, root, events_path.parent / 'delivery-checks')
            elif packets[packet_id].get('delivery_kind') == 'local_source_only':
                workspace = checked_path(plan_path.parent, packets[packet_id]['target_repo'], root)
                require(git(workspace, 'rev-parse', 'HEAD').decode().strip() == checks[packet_id]['base_commit']
                        and not git(workspace, 'status', '--porcelain=v1').strip(),
                        'local target changed or dirty; refreeze before claim')
            claim_id = str(uuid.uuid4())
            queue_action, event_type = 'claimed', 'received'
        else:
            old = history.get(packet_id)
            require(packet_id in states and old is not None and old['queue_action'] == 'claimed',
                    'packet has no active claim')
            require(claim_id == old['claim_id'] and old['approval_sha256'] == approval_sha, 'claim/approval mismatch')
            receipt_path = pinned(plan_path.parent, dict(path=str(receipt), sha256=receipt_sha), root)
            evidence = read_json(receipt_path, receipt_sha)
            require(isinstance(evidence, dict), 'invalid writer receipt')
            packet = packets.get(packet_id, dict(old, tree=old['candidate_tree']))
            require(evidence.get('packet_id') == packet_id and evidence.get('candidate_commit') == packet['candidate_commit']
                    and evidence.get('source_tree' if standing else 'tree') == packet['tree']
                    and evidence.get('manifest_sha256') == packet['manifest_sha256'], 'receipt source mismatch')
            queue_action = evidence.get('status')
            require(queue_action in ('integrated', 'failed'), 'invalid receipt outcome')
            require(not expired or queue_action == 'failed', 'expired claim may only record failure')
            if queue_action == 'integrated':
                require(states[packet_id] == 'claimed', 'changed packet cannot be integrated')
                workspace = checked_path(plan_path.parent, evidence.get('workspace'), root)
                require(evidence.get('clean') is True and evidence.get('commands_stopped') is True,
                        'writer commands/working tree not settled')
                if packet.get('delivery_kind') == 'local_source_only':
                    require(workspace == checked_path(plan_path.parent, packet['target_repo'], root), 'wrong local integration target')
                actual = git(workspace, 'rev-parse', 'HEAD').decode().strip()
                if standing:
                    from source_binding import DIFF_ARGS
                    require(all(evidence.get(k) == old[k] for k in ('target_base', 'target_tree', 'target_delta_sha256')),
                            'receipt target projection mismatch')
                    require(actual == evidence.get('commit')
                            and git(workspace, 'rev-parse', 'HEAD^{tree}').decode().strip() == old['target_tree']
                            and git(workspace, 'rev-parse', 'HEAD^').decode().strip() == old['target_base']
                            and sha(git(workspace, 'diff', *DIFF_ARGS, old['target_base'], actual)) == old['target_delta_sha256']
                            and not git(workspace, 'status', '--porcelain=v1').strip(),
                            'receipt does not describe actual target CAS integration')
                else:
                    require(actual == evidence.get('commit')
                        and git(workspace, 'rev-parse', 'HEAD^{tree}').decode().strip() == packet['tree']
                        and git(workspace, 'rev-parse', 'HEAD^').decode().strip() == evidence.get('parent')
                        == checks[packet_id]['base_commit'] and not git(workspace, 'status', '--porcelain=v1').strip(),
                        'receipt does not describe the actual clean Git integration')
            else:
                require(isinstance(evidence.get('error'), str) and evidence['error'], 'failure reason is required')
            event_type = 'integrated' if queue_action == 'integrated' else 'rework'
        packet = packets.get(packet_id)
        if packet is None:
            old = history[packet_id]
            packet = dict(old, tree=old['candidate_tree'])
        event = {key: packet[key] for key in ('packet_id', 'candidate_commit', 'manifest_path',
                 'manifest_sha256', 'ac_ids', 'dependencies', 'next_owner', 'ready_at', 'source_class')}
        if 'task_owner' in packet:
            event.update({k: packet[k] for k in ('trial_id', 'task_owner', 'task_id')})
        observed = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
        if packet.get('delivery_kind') == 'local_source_only':
            event['event_scope'] = packet.get('event_scope', 'product' if 'task_owner' in packet else 'preparation')
        event.update(timestamp_basis='process_observed', observed_at=observed,
                     timestamp_provenance=dict(basis='process_observed', process_observed_at=observed, actor_reported_at=None, native_observed_at=None))
        if queue_action == 'claimed':
            event['received_at'] = observed
        elif queue_action == 'integrated':
            event['received_at'] = old.get('received_at')
            event['integrated_at'] = observed
        event.update(schema_version=1, owner='13', next_owner=str(packet['next_owner']), candidate_tree=packet['tree'],
                     event_id=sha(canonical([approval_sha, packet_id, queue_action])),
                     occurred_at=observed,
                     event_type=event_type, queue_action=queue_action, claim_id=claim_id,
                     approval_sha256=approval_sha,
                     packet_sha256=checks[packet_id]['packet_sha256'] if packet_id in checks else history[packet_id]['packet_sha256'])
        if standing:
            event['event_scope'] = packet.get('event_scope', policy['event_scope'])
            event.update(source_binding_sha256=packet['source_binding_sha256'],
                         source_application_sha256=checks.get(packet_id, old if action == 'record' else {}).get('source_application_sha256'),
                         source_packet_path=str(Path(packet_path).resolve()), source_review_ref=review_ref)
            event.update(projection if queue_action == 'claimed' else
                         {k: old[k] for k in ('target_base', 'target_tree', 'target_delta_sha256')})
        if receipt is not None:
            event.update(evidence_path=str(receipt_path), evidence_sha256=receipt_sha)
        require(sha(plan_path.read_bytes()) == approval_sha, 'approval changed before append')
        if standing and queue_action != 'failed':
            pinned(plan_path.parent, dict(path=str(packet_path), sha256=event['packet_sha256']), root)
            pinned(Path(packet_path).parent, review_ref, root)
        with events_path.open('ab') as stream:
            stream.write(canonical(event) + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        states[packet_id] = queue_action
        for entry in entries:
            key, dependencies = entry['packet_id'], entry['dependencies']
            if states[key] not in ('ready', 'waiting', 'blocked'):
                continue
            states[key] = ('blocked' if any(states.get(d, history.get(d, {}).get('queue_action')) in ('failed', 'invalid', 'blocked') for d in dependencies)
                           else 'ready' if all(states.get(d, history.get(d, {}).get('queue_action')) == 'integrated' for d in dependencies) else 'waiting')
    return dict(ok=True, states=states, errors=errors, packet_id=packet_id, claim_id=claim_id, event=event,
                runner_execution_authorized=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('approved', type=Path)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--action', choices=['status', 'claim', 'record'], required=True)
    parser.add_argument('--packet-id')
    parser.add_argument('--claim-id')
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--receipt-sha')
    for name in ('approval-sha', 'packet-path', 'packet-sha', 'source-review', 'source-review-sha'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    try:
        result = advance(args.approved, args.events, args.root, args.action, packet_id=args.packet_id,
                         claim_id=args.claim_id, receipt=args.receipt, receipt_sha=args.receipt_sha,
                         approval_sha=args.approval_sha, packet_path=args.packet_path, packet_sha=args.packet_sha,
                         source_review=args.source_review, source_review_sha=args.source_review_sha)
        print(json.dumps(result, ensure_ascii=False))
    except (DeliveryError, OSError, ValueError, KeyError) as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False))
        raise SystemExit(1)
