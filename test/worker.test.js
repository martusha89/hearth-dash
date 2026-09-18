import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationHandler, isOAuthRoute, oauthApiHandler } from '../worker.js';

class FakeD1 {
  constructor() { this.counts = new Map(); }

  prepare(sql) {
    const db = this;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async run() {
        if (sql.startsWith('INSERT INTO rate_limits')) {
          const key = this.args[0];
          db.counts.set(key, (db.counts.get(key) || 0) + 1);
        }
        return { success: true };
      },
      async first() {
        if (sql.startsWith('SELECT count FROM rate_limits')) return { count: db.counts.get(this.args[0]) || 0 };
        return null;
      },
      async all() { return { results: [] }; },
    };
  }
}

class FakeKv {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async list() { return { keys: [], list_complete: true }; }
}

function env(overrides = {}) {
  return {
    DB: new FakeD1(),
    OAUTH_KV: new FakeKv(),
    DASHBOARD_PASSWORD: 'correct horse battery staple',
    SESSION_SECRET: 's'.repeat(43),
    PARTNER_1: 'One',
    PARTNER_2: 'Two',
    HEARTH_URL: 'https://hearth.example',
    ...overrides,
  };
}

function executionContext(scopes = ['hearth:read', 'hearth:write']) {
  return { props: { userId: 'hearth-owner', scopes }, waitUntil() {}, passThroughOnException() {} };
}

function mcpRequest(body, headers = {}, path = '/mcp') {
  return new Request(`https://hearth.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function callMcp(body, testEnv = env(), scopes, headers = {}) {
  testEnv.OAUTH_PROVIDER = { async unwrapToken() { return { scope: scopes || ['hearth:read', 'hearth:write'] }; } };
  return oauthApiHandler.fetch(mcpRequest(body, {
    Authorization: 'Bearer test-token',
    'MCP-Protocol-Version': '2025-06-18',
    ...headers,
  }), testEnv, executionContext(scopes));
}

test('rejects legacy secret-bearing MCP paths after OAuth authentication', async () => {
  const response = await oauthApiHandler.fetch(
    mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, {}, '/mcp/old-secret'),
    env(), executionContext(),
  );
  assert.equal(response.status, 404);
});

test('implements MCP initialize and scoped tool discovery over JSON-RPC', async () => {
  const initialized = await callMcp({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(initialized.status, 200);
  const initBody = await initialized.json();
  assert.equal(initBody.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initBody.result.capabilities, { tools: { listChanged: false } });

  const listed = await callMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, env(), ['hearth:read'], { 'MCP-Protocol-Version': '2025-06-18' });
  const listBody = await listed.json();
  assert.ok(listBody.result.tools.length >= 10);
  assert.ok(listBody.result.tools.every(tool => tool.inputSchema?.type === 'object'));
  assert.ok(!listBody.result.tools.some(tool => tool.name === 'hearth_food_review'));
});

test('rejects the old custom tool/params format', async () => {
  const response = await callMcp({ tool: 'hearth_status', params: {} });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, -32600);
});

test('calls an authorized read tool and returns MCP content', async () => {
  const response = await callMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hearth_status', arguments: {} } }, env(), ['hearth:read']);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, false);
  assert.equal(body.result.content[0].type, 'text');
  assert.deepEqual(body.result.structuredContent.moods, { One: null, Two: null });
});

test('enforces write scope and validates arguments before writes', async () => {
  const denied = await callMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hearth_shopping_add', arguments: { item: 'Tea' } } }, env(), ['hearth:read']);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.result.isError, true);
  assert.match(deniedBody.result.content[0].text, /hearth:write/);

  const invalid = await callMcp({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'hearth_mood', arguments: { action: 'set', partner: 'One', mood: '<script>' } },
  });
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.result.isError, true);
  assert.match(invalidBody.result.content[0].text, /must be one of/);
});

test('uses effective token scope rather than stale authorization props', async () => {
  const testEnv = env({
    OAUTH_PROVIDER: { async unwrapToken() { return { scope: ['hearth:read'] }; } },
  });
  const response = await oauthApiHandler.fetch(mcpRequest({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'hearth_shopping_add', arguments: { item: 'Tea' } },
  }, { Authorization: 'Bearer narrowed-token', 'MCP-Protocol-Version': '2025-06-18' }), testEnv, executionContext(['hearth:read', 'hearth:write']));
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /hearth:write/);
});

test('validates browser origins and unsupported protocol versions', async () => {
  const forbidden = await callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, env(), undefined, { Origin: 'https://evil.example' });
  assert.equal(forbidden.status, 403);

  const unsupported = await callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, env(), undefined, { 'MCP-Protocol-Version': '1999-01-01' });
  assert.equal(unsupported.status, 400);
});

test('requires negotiated protocol metadata after initialize', async () => {
  const missingVersion = await callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, env(), undefined, { 'MCP-Protocol-Version': '' });
  assert.equal(missingVersion.status, 400);
  const missingInitializeVersion = await callMcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  assert.equal(missingInitializeVersion.status, 400);
});

test('issues a signed secure session rather than storing the password in the cookie', async () => {
  const testEnv = env();
  const form = new FormData();
  form.set('password', testEnv.DASHBOARD_PASSWORD);
  const response = await applicationHandler.fetch(new Request('https://hearth.example/login', {
    method: 'POST', headers: { Origin: 'https://hearth.example' }, body: form,
  }), testEnv);
  assert.equal(response.status, 302);
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /__Host-hearth_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.ok(!cookie.includes(testEnv.DASHBOARD_PASSWORD));
});

test('rejects contradictory non-null Origin even with same-origin Fetch Metadata', async () => {
  const testEnv = env();
  const form = new FormData();
  form.set('password', testEnv.DASHBOARD_PASSWORD);
  const response = await applicationHandler.fetch(new Request('https://worker-internal.example/login', {
    method: 'POST',
    headers: {
      Origin: 'https://hearth.example',
      Host: 'hearth.example',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: form,
  }), testEnv);
  assert.equal(response.status, 403);
});

test('accepts Chrome same-origin login when Origin is serialized as null', async () => {
  const testEnv = env();
  const form = new FormData();
  form.set('password', testEnv.DASHBOARD_PASSWORD);
  const response = await applicationHandler.fetch(new Request('https://hearth-dash.vixen1590.workers.dev/login', {
    method: 'POST',
    headers: {
      Origin: 'null',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: form,
  }), testEnv);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('Set-Cookie'), /__Host-hearth_session=/);
});

test('applies a strict Fetch Metadata and Origin decision table', async () => {
  const cases = [
    { fetchSite: 'same-origin', origin: 'https://hearth.example', expected: 302 },
    { fetchSite: 'same-origin', origin: 'null', expected: 302 },
    { fetchSite: 'same-origin', origin: null, expected: 302 },
    { fetchSite: 'same-origin', origin: 'https://evil.example', expected: 403 },
    { fetchSite: 'same-origin', origin: 'not a URL', expected: 403 },
    { fetchSite: 'same-origin', origin: 'https://hearth.example, https://evil.example', expected: 403 },
    { fetchSite: 'same-site', origin: 'https://hearth.example', expected: 403 },
    { fetchSite: 'cross-site', origin: 'https://hearth.example', expected: 403 },
    { fetchSite: 'none', origin: null, expected: 403 },
    { fetchSite: null, origin: 'https://hearth.example', expected: 302 },
    { fetchSite: null, origin: 'null', expected: 403 },
    { fetchSite: null, origin: null, expected: 403 },
    { fetchSite: 'future-value', origin: 'https://hearth.example', expected: 302 },
    { fetchSite: 'future-value', origin: null, expected: 403 },
  ];

  for (const item of cases) {
    const headers = {};
    if (item.fetchSite !== null) headers['Sec-Fetch-Site'] = item.fetchSite;
    if (item.origin !== null) headers.Origin = item.origin;
    const form = new FormData();
    form.set('password', env().DASHBOARD_PASSWORD);
    const response = await applicationHandler.fetch(new Request('https://hearth.example/login', {
      method: 'POST', headers, body: form,
    }), env());
    assert.equal(response.status, item.expected, JSON.stringify(item));
  }
});

test('still rejects cross-site dashboard posts', async () => {
  const form = new FormData();
  form.set('password', 'wrong password');
  const response = await applicationHandler.fetch(new Request('https://hearth.example/login', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: form,
  }), env());
  assert.equal(response.status, 403);
});

test('routes only MCP and OAuth protocol paths through the OAuth provider', () => {
  for (const path of ['/mcp', '/mcp/legacy', '/authorize', '/oauth/token', '/oauth/register', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
    assert.equal(isOAuthRoute(path), true, path);
  }
  for (const path of ['/', '/login', '/logout', '/api/dashboard', '/api/food/photo']) {
    assert.equal(isOAuthRoute(path), false, path);
  }
});

test('escapes configured partner names in HTML and inline JavaScript', async () => {
  const testEnv = env({ PARTNER_1: '</script><img src=x onerror=alert(1)>', PARTNER_2: "O'Malley" });
  const form = new FormData();
  form.set('password', testEnv.DASHBOARD_PASSWORD);
  const login = await applicationHandler.fetch(new Request('https://hearth.example/login', {
    method: 'POST', headers: { Origin: 'https://hearth.example' }, body: form,
  }), testEnv);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const dashboard = await applicationHandler.fetch(new Request('https://hearth.example/', { headers: { Cookie: cookie } }), testEnv);
  const html = await dashboard.text();
  assert.ok(!html.includes('</script><img src=x'));
  assert.ok(html.includes('&lt;/script&gt;&lt;img'));
  assert.ok(html.includes("O&#39;Malley"));
});

test('returns 405 for authenticated MCP GET when no SSE stream is offered', async () => {
  const response = await oauthApiHandler.fetch(new Request('https://hearth.example/mcp', {
    method: 'GET', headers: { Accept: 'text/event-stream', Authorization: 'Bearer test-token' },
  }), env({ OAUTH_PROVIDER: { async unwrapToken() { return { scope: ['hearth:read'] }; } } }), executionContext());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'POST');
});
