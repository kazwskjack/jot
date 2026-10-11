"""MCP request metadata intake; no model parameters or callback URL claims."""
from collections.abc import Mapping
from contextlib import contextmanager
import re

from .budget import BudgetFailure, bind_budget, ticket_client, without_budget


@contextmanager
def request_budget_scope(context, callback_origin, *, required=False):
    if not isinstance(required, bool):
        raise BudgetFailure('web_budget_config_invalid')
    try:
        metadata = context.request_context.meta if context is not None else None
    except (AttributeError, ValueError, LookupError):
        metadata = None
    if metadata is not None and not isinstance(metadata, Mapping):
        try:
            metadata = metadata.model_dump(by_alias=True, exclude_none=True)
        except Exception:
            raise BudgetFailure('web_budget_metadata_invalid') from None
    if metadata is not None and not isinstance(metadata, Mapping):
        raise BudgetFailure('web_budget_metadata_invalid')
    if metadata is None or 'jot_web_budget' not in metadata:
        if required:
            raise BudgetFailure('web_budget_required')
        with without_budget():
            yield
        return
    ticket = metadata['jot_web_budget']
    if (not isinstance(ticket, Mapping) or set(ticket) != {'protocol', 'grant'}
            or type(ticket['protocol']) is not int or ticket['protocol'] != 1
            or not isinstance(ticket['grant'], str)
            or not re.fullmatch('[a-f0-9]{64}', ticket['grant'])):
        raise BudgetFailure('web_budget_metadata_invalid')
    # The origin is supplied only by fixed host configuration. The wire ticket
    # carries no identity or networking destination and is validated again by
    # the original gateway when a provider reserves or dispatches.
    with bind_budget(ticket_client(callback_origin, ticket['grant'])):
        yield
