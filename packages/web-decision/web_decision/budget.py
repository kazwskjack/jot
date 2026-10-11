"""Trusted request-scoped accounting for external web-decision invocations.

No planner, browser permission, model-supplied identity, or automatic retry lives
here. Host metadata intake and provider result journaling are separate boundaries.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from hashlib import sha256
import json
import os
import re
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler


class BudgetFailure(RuntimeError):
    def __init__(self, code='web_budget_unavailable'):
        super().__init__(code)


_command = ContextVar('web_decision_budget_command', default=None)
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,191}\Z')


@contextmanager
def bind_budget(command):
    """Bind only a host-validated ticket client, never a model argument.

    Explicit copy_context().run is required when launching new threads. Bindings
    restore on every exit and must never be stored on shared provider instances.
    """
    if not callable(command):
        raise BudgetFailure()
    token = _command.set(command)
    try:
        yield
    finally:
        _command.reset(token)


@contextmanager
def without_budget():
    """A separate unbudgeted request cannot inherit its caller's authority."""
    token = _command.set(None)
    try:
        yield
    finally:
        _command.reset(token)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BudgetFailure()


def ticket_client(origin, grant, timeout=5):
    """Opaque-ticket client for a fixed loopback host; proxy/redirects disabled."""
    parsed = urlsplit(origin)
    if (parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1')
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or parsed.username or parsed.password or not isinstance(grant, str)
            or not re.fullmatch('[a-f0-9]{64}', grant)
            or not isinstance(timeout, (int, float)) or isinstance(timeout, bool)
            or not 0 < timeout <= 15):
        raise BudgetFailure()
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    endpoint = origin.rstrip('/') + '/internal/v1/workbench/web-model-budget'
    def command(body):
        try:
            encoded = json.dumps(body, allow_nan=False, separators=(',', ':')).encode()
            if len(encoded) > 1048576:
                raise BudgetFailure()
            request = Request(endpoint, data=encoded, method='POST', headers={
                'Authorization': 'Bearer '+grant, 'Content-Type': 'application/json',
            })
            with opener.open(request, timeout=timeout) as response:
                data = response.read(1048577)
                if len(data) > 1048576 or response.status != 200:
                    raise BudgetFailure()
                value = json.loads(data)
                if not isinstance(value, dict):
                    raise BudgetFailure()
                return value
        except Exception:
            # Do not surface the request, ticket, runtime hostname or response.
            raise BudgetFailure() from None
    return command


def invoke_provider_call(provider, model, request_id, payload, invoke, usage=None):
    """Call at the actual provider submission point, after input/egress checks.

    Legacy optional requests are unchanged. Required host mode can never use
    that unmetered path, including when a caller forgot to copy its context.
    """
    required = str(os.environ.get('UNIVERSE_WEB_BUDGET_REQUIRED', '0')).strip().lower()
    if required not in {'0', 'false', 'off', '1', 'true', 'on'}:
        raise BudgetFailure('web_budget_config_invalid')
    wire = {'request_id': request_id, 'payload': payload}
    if _command.get() is None:
        if required in {'1', 'true', 'on'}:
            raise BudgetFailure('web_budget_required')
        return invoke(wire)
    return BudgetedPredictor(invoke, provider, model, usage, journal=True).predict(wire)


class BudgetedPredictor:
    def __init__(self, invoke, provider, model, usage=None, *, journal=False):
        if (not callable(invoke) or provider not in ('openjev', 'laya')
                or not isinstance(model, str) or not model or len(model) > 256
                or usage is not None and not callable(usage) or not isinstance(journal, bool)):
            raise BudgetFailure()
        self.invoke, self.provider, self.model, self.usage = invoke, provider, model, usage
        self.journal = journal

    def predict(self, request):
        command = _command.get()
        if (not callable(command) or not isinstance(request, dict)
                or not isinstance(request.get('request_id'), str)
                or not _ID.fullmatch(request['request_id'])):
            raise BudgetFailure('web_budget_required')
        try:
            body = json.dumps(request, sort_keys=True, ensure_ascii=False,
                              allow_nan=False, separators=(',', ':')).encode()
            if len(body) > 524288:
                raise BudgetFailure()
            frozen = json.loads(body)
            reserved = command({'action': 'reserve', 'request_id': frozen['request_id'],
                                'provider': self.provider, 'model': self.model,
                                'request_hash': sha256(body).hexdigest()})
            receipt = reserved['receipt']
            attempt = receipt['attempt_id']
            if not isinstance(attempt, str) or not _ID.fullmatch(attempt):
                raise BudgetFailure('web_budget_reconciliation_required')
            if reserved.get('fresh') is not True:
                if self.journal and reserved.get('fresh') is False and receipt.get('state') in ('in_flight', 'unknown', 'settled'):
                    from .response_codec import decode_response
                    recorded = command({'action': 'response_read', 'attempt_id': attempt}).get('response')
                    if recorded is None:
                        raise BudgetFailure('web_budget_reconciliation_required')
                    return self._finish(command, attempt, receipt, decode_response(recorded))
                raise BudgetFailure('web_budget_reconciliation_required')
            if receipt.get('state') != 'reserved':
                raise BudgetFailure('web_budget_reconciliation_required')
        except BudgetFailure:
            raise
        except Exception:
            raise BudgetFailure() from None

        dispatched = False
        try:
            # Set before awaiting: a lost acknowledgement does not mean unsent.
            dispatched = True
            response = command({'action': 'dispatch', 'attempt_id': attempt})
            receipt = response['receipt']
            if receipt.get('attempt_id') != attempt or receipt.get('state') not in ('in_flight', 'settled'):
                raise BudgetFailure()
        except Exception:
            self._unknown(command, attempt, 'transport_unknown')
            raise BudgetFailure('web_budget_dispatch_unknown') from None

        try:
            result = self.invoke(frozen)
        except Exception:
            if dispatched:
                self._unknown(command, attempt, 'provider_failed')
            raise BudgetFailure('web_budget_provider_failed') from None
        if self.journal:
            try:
                from .response_codec import encode_response, decode_response
                encoded = encode_response(result)
                try:
                    recorded = command({'action': 'response_record', 'attempt_id': attempt, **encoded}).get('response')
                    if recorded != encoded:
                        raise BudgetFailure('web_budget_response_pending')
                except Exception:
                    recorded = command({'action': 'response_read', 'attempt_id': attempt}).get('response')
                    if recorded != encoded:
                        raise BudgetFailure('web_budget_response_pending')
                result = decode_response(recorded)
            except Exception:
                self._unknown(command, attempt, 'settlement_pending')
                raise BudgetFailure('web_budget_response_pending') from None
        return self._finish(command, attempt, receipt, result)

    def _finish(self, command, attempt, receipt, result):
        if receipt['state'] == 'settled':
            # Configured dispatched-call quota is already charged. Never invent
            # tokens from payload size, duration, scores, or result contents.
            return result
        try:
            usage = self.usage(result) if self.usage else None
            if usage is None:
                self._unknown(command, attempt, 'usage_incomplete')
                raise BudgetFailure('web_budget_usage_unknown')
            settled = command({'action': 'settle', 'attempt_id': attempt, 'usage': usage})['receipt']
            if settled.get('attempt_id') != attempt or settled.get('state') != 'settled':
                raise BudgetFailure()
            return result
        except BudgetFailure as error:
            if str(error) == 'web_budget_usage_unknown':
                raise
            self._unknown(command, attempt, 'settlement_pending')
            raise BudgetFailure('web_budget_settlement_unknown') from None
        except Exception:
            self._unknown(command, attempt, 'settlement_pending')
            raise BudgetFailure('web_budget_settlement_unknown') from None

    @staticmethod
    def _unknown(command, attempt, reason):
        try:
            command({'action': 'unknown', 'attempt_id': attempt, 'reason': reason})
        except Exception:
            # Missing accounting confirmation stays unresolved. No retry,
            # release, new request id, or speculative provider invocation.
            pass
