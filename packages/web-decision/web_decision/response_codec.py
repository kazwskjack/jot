"""Bounded original-response frames; no cookies or authentication headers."""
import base64
from dataclasses import dataclass
from hashlib import sha256
import json

from .budget import BudgetFailure


@dataclass(frozen=True)
class RecordedHTTPResponse:
    status_code: int
    content: bytes
    headers: dict

    def json(self):
        return json.loads(self.content)


def encode_response(result):
    try:
        if isinstance(result, (dict, list, str, int, float, bool, type(None))):
            frame = {'protocol': 1, 'encoding': 'json', 'value': result}
        else:
            content = result.content
            if type(result.status_code) is not int or not 100 <= result.status_code <= 599 or not isinstance(content, (bytes, bytearray)) or len(content) > 131072:
                raise ValueError()
            retry = result.headers.get('Retry-After')
            if retry is not None and (not isinstance(retry, str) or len(retry) > 256 or any(ord(c) < 32 or ord(c) > 126 for c in retry)):
                retry = None
            frame = {'protocol': 1, 'encoding': 'http', 'status_code': result.status_code,
                     'body_base64': base64.b64encode(content).decode('ascii'), 'retry_after': retry}
        encoded = json.dumps(frame, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        data = encoded.encode('utf-8')
        if len(data) > 262144:
            raise ValueError()
        return {'response_json': encoded, 'response_hash': sha256(data).hexdigest()}
    except Exception:
        raise BudgetFailure('web_budget_response_invalid') from None


def decode_response(record):
    try:
        if not isinstance(record, dict) or set(record) != {'response_json', 'response_hash'} or not isinstance(record['response_json'], str):
            raise ValueError()
        data = record['response_json'].encode('utf-8')
        if len(data) > 262144 or sha256(data).hexdigest() != record['response_hash']:
            raise ValueError()
        def invalid_constant(value):
            raise ValueError()
        frame = json.loads(data, parse_constant=invalid_constant)
        if not isinstance(frame, dict) or type(frame.get('protocol')) is not int or frame['protocol'] != 1:
            raise ValueError()
        if frame.get('encoding') == 'json' and set(frame) == {'protocol', 'encoding', 'value'}:
            return frame['value']
        if frame.get('encoding') != 'http' or set(frame) != {'protocol', 'encoding', 'status_code', 'body_base64', 'retry_after'}:
            raise ValueError()
        content = base64.b64decode(frame['body_base64'], validate=True)
        retry = frame['retry_after']
        if (type(frame['status_code']) is not int or not 100 <= frame['status_code'] <= 599
                or len(content) > 131072 or base64.b64encode(content).decode('ascii') != frame['body_base64']
                or retry is not None and (not isinstance(retry, str) or len(retry) > 256 or any(ord(c) < 32 or ord(c) > 126 for c in retry))):
            raise ValueError()
        return RecordedHTTPResponse(frame['status_code'], content, {} if retry is None else {'Retry-After': retry})
    except Exception:
        raise BudgetFailure('web_budget_response_invalid') from None
