"""Fail-closed route pins for trusted, budgeted model deployments.

The digest identifies deployment configuration, never authorizes a request.
Keep caller authentication and model accounting at their existing boundaries.
"""

import hashlib
import hmac
import json
import re

_PIN = re.compile(r"sha256:[a-f0-9]{64}\Z")
PINNED_MODEL_PREFIX = "jot-pinned:"
_FIELDS = (
    "id", "provider", "model", "enabled", "transport", "api_base", "proxy",
    "extra_query", "extra_body", "extra_headers", "omit_store", "max_tokens",
    "api_key_env", "api_env_file",
)


def route_fingerprint(item):
    """Hash one trusted manifest; never include loaded credentials in it."""
    if not isinstance(item, dict):
        raise ValueError("proxy_route_pin_invalid")
    try:
        snapshot = {field: item.get(field) for field in _FIELDS}
        encoded = json.dumps(snapshot, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        raise ValueError("proxy_route_pin_invalid") from None
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def verify_route_pin(item, incoming, route_pin):
    """Validate before reading upstream credentials or submitting the request."""
    if not isinstance(route_pin, str) or not _PIN.fullmatch(route_pin):
        raise ValueError("proxy_route_pin_invalid")
    if not hmac.compare_digest(route_pin, route_fingerprint(item)):
        raise ValueError("proxy_route_changed")
    if not isinstance(incoming, dict) or incoming.get("model") not in (item.get("model"), pinned_model_id(item)):
        raise ValueError("proxy_pinned_model_mismatch")


def pinned_model_id(item):
    """Use this immutable wire name in both the SDK catalog and budget route."""
    model = item.get("model") if isinstance(item, dict) else None
    if (not isinstance(model, str) or not model or len(model) > 180
            or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in model)):
        raise ValueError("proxy_route_pin_invalid")
    return PINNED_MODEL_PREFIX + route_fingerprint(item)[7:] + ":" + model
