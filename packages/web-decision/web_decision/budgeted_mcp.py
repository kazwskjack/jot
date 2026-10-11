"""Budget scope at the existing FastMCP dispatch boundary, not tool arguments."""
from .request_budget import request_budget_scope


def budgeted_server_type(base, callback_origin, required):
    if not callable(callback_origin) or not callable(required):
        raise TypeError('web_budget_host_config_invalid')
    class RequestBudgetServer(base):
        async def call_tool(self, name, arguments):
            # FastMCP installs self.call_tool as its existing protocol handler;
            # every original tool keeps its original signature and schema.
            with request_budget_scope(self.get_context(), callback_origin(), required=required()):
                return await super().call_tool(name, arguments)
    return RequestBudgetServer
