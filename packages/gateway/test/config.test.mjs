import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBffConfig } from '../src/config.ts';
import { randomBytes } from 'node:crypto';

const syntheticToken = () => randomBytes(32).toString('base64url');

const requiredEnvironment = {
  GENERAL_AGENT_CSRF_TOKEN: syntheticToken(),
  GENERAL_AGENT_ALLOWED_ORIGINS: 'https://jot.example',
  GENERAL_AGENT_WORKSPACES: 'main',
  GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN: syntheticToken(),
};

function withEnvironment(overrides, operation) {
  const keys = [...new Set([...Object.keys(requiredEnvironment), 'GENERAL_AGENT_HOST'])];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(requiredEnvironment)) process.env[key] = value;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return operation();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Gateway config defaults to a loopback listener and accepts explicit loopback addresses', () => {
  assert.equal(withEnvironment({ GENERAL_AGENT_HOST: undefined }, () => loadBffConfig().host), '127.0.0.1');
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(withEnvironment({ GENERAL_AGENT_HOST: host }, () => loadBffConfig().host), host);
  }
});

test('Gateway config rejects a non-loopback bind while actor identity is header based', () => {
  for (const host of ['0.0.0.0', '::', '192.0.2.10', '2001:db8::1', 'gateway.jot.example']) {
    assert.throws(
      () => withEnvironment({ GENERAL_AGENT_HOST: host }, () => loadBffConfig()),
      error => error instanceof Error && error.message === 'config_public_api_identity_required',
      host,
    );
  }
});
