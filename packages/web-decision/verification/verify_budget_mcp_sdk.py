"""Real SDK memory transport; synthetic provider/accounting, no production IO."""
import asyncio
import json
from importlib.metadata import version
from unittest.mock import patch
import anyio
import mcp.types as types
from mcp.server.fastmcp import FastMCP
from mcp.shared.memory import create_connected_server_and_client_session
from web_decision.budget import BudgetedPredictor, BudgetFailure, invoke_provider_call
from web_decision.budgeted_mcp import budgeted_server_type


async def main():
    seen = []
    def client(origin, grant):
        assert origin == 'http://127.0.0.1:18831'
        label = 'one' if grant == 'a'*64 else 'two'
        def command(body):
            if body['action']=='reserve':
                assert body['request_id']==label, 'cross-request budget context leaked'
            seen.append((label, body['action']))
            return {'fresh': True, 'receipt': {'attempt_id': 'web-'+label,
                    'state': 'reserved' if body['action'] == 'reserve' else 'settled'}}
        return command
    server_type = budgeted_server_type(FastMCP, lambda: 'http://127.0.0.1:18831', lambda: True)
    server = server_type('test-budget-sdk')
    provider_calls = []
    @server.tool()
    async def probe(request_id: str) -> dict:
        def invoke():
            return BudgetedPredictor(lambda r: provider_calls.append(r['request_id']) or r,
                                     'openjev', 'openjev').predict({'request_id': request_id})
        return await anyio.to_thread.run_sync(invoke)
    with patch('web_decision.request_budget.ticket_client', client):
        async with create_connected_server_and_client_session(server._mcp_server) as session:
            tools = await session.list_tools()
            assert set(tools.tools[0].inputSchema['properties']) == {'request_id'}
            async def call(label, grant):
                params = types.CallToolRequestParams(name='probe', arguments={'request_id': label},
                    _meta={'jot_web_budget': {'protocol': 1, 'grant': grant}})
                result = await session.send_request(types.ClientRequest(types.CallToolRequest(method='tools/call', params=params)), types.CallToolResult)
                assert not result.isError
                return json.loads(result.content[0].text)
            results = await asyncio.gather(call('one', 'a'*64), call('two', 'b'*64))
            assert results == [{'request_id': 'one'}, {'request_id': 'two'}]
            missing = await session.call_tool('probe', {'request_id': 'no-authority'})
            assert missing.isError
            malformed = types.CallToolRequestParams(name='probe', arguments={'request_id':'malformed'},
                _meta={'jot_web_budget':{'protocol':1,'grant':'invalid'}})
            rejected = await session.send_request(types.ClientRequest(types.CallToolRequest(method='tools/call',params=malformed)),types.CallToolResult)
            assert rejected.isError
    assert sorted(provider_calls) == ['one', 'two']
    assert sorted(seen) == [('one', 'dispatch'), ('one', 'reserve'), ('two', 'dispatch'), ('two', 'reserve')]
    print('PASS: official MCP '+version('mcp')+' memory transport preserves metadata, concurrent request/worker contexts, unchanged schema and missing/malformed-ticket denial. Synthetic provider/accounting only.')


async def optional_main():
    seen, provider_calls = [], []
    def client(origin, grant):
        assert origin == 'http://127.0.0.1:18833'
        if grant not in ['a'*64, 'b'*64]:
            raise BudgetFailure('web_budget_required')
        label = 'one' if grant == 'a'*64 else 'two'
        def command(body):
            if body['action']=='reserve':
                assert body['request_id']==label, 'cross-request budget context leaked'
            seen.append((label, body['action']))
            if body['action'] == 'response_record':
                return {'response': {k:v for k,v in body.items() if k not in ['action','attempt_id']}}
            return {'fresh': True, 'receipt': {'attempt_id': 'web-'+label,
                'state': {'reserve':'reserved','dispatch':'in_flight','settle':'settled'}.get(body['action'],'unknown')}}
        return command
    Server = budgeted_server_type(FastMCP, lambda:'http://127.0.0.1:18833', lambda:False)
    server = Server('optional-budget-sdk')
    @server.tool()
    async def optional_probe(request_id: str) -> dict:
        def invoke():
            return invoke_provider_call('openjev','openjev',request_id,{'fixture':True},
                lambda wire:provider_calls.append(wire['request_id']) or {'request_id':wire['request_id']},
                lambda result:{'inputTokens':1,'outputTokens':1,'totalTokens':2})
        return await anyio.to_thread.run_sync(invoke)
    with patch.dict('os.environ',{'UNIVERSE_WEB_BUDGET_REQUIRED':'0'}), patch('web_decision.request_budget.ticket_client',client):
        async with create_connected_server_and_client_session(server._mcp_server) as session:
            schema=(await session.list_tools()).tools[0].inputSchema
            assert set(schema['properties'])=={'request_id'}
            async def call(label, grant=None):
                fields={'name':'optional_probe','arguments':{'request_id':label}}
                if grant is not None:
                    fields['_meta']={'jot_web_budget':{'protocol':1,'grant':grant}}
                params=types.CallToolRequestParams(**fields)
                return await session.send_request(types.ClientRequest(types.CallToolRequest(method='tools/call',params=params)),types.CallToolResult)
            results=await asyncio.gather(call('one','a'*64),call('ordinary'),call('two','b'*64))
            assert all(not x.isError for x in results)
            assert [json.loads(x.content[0].text) for x in results]==[{'request_id':'one'},{'request_id':'ordinary'},{'request_id':'two'}]
            for label,grant in [('malformed','invalid'),('wrong-ticket','c'*64)]:
                assert (await call(label,grant)).isError
    assert sorted(provider_calls)==['one','ordinary','two']
    assert sorted(seen)==[(label,action) for label in ['one','two'] for action in ['dispatch','reserve','response_record','settle']]
    print('PASS: official MCP '+version('mcp')+' optional intake concurrently preserves ordinary requests and isolated ticketed accounting; malformed/wrong ticket rejected before provider. Fixed callback matches application tunnel; synthetic providers/accounting, no production IO.')


if __name__ == '__main__':
    async def bounded_main():
        with anyio.fail_after(20):
            await main()
            await optional_main()
    anyio.run(bounded_main)
