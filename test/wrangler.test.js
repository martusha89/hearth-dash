import test from 'node:test';
import assert from 'node:assert/strict';
import { parseD1CreateOutput, parseDeployOutput, parseKvCreateOutput } from '../cli/lib/wrangler.js';

test('parses Cloudflare storage and deployment output', () => {
  assert.equal(parseD1CreateOutput({ stdout: 'database_id = "12345678-1234-1234-1234-123456789abc"', stderr: '' }), '12345678-1234-1234-1234-123456789abc');
  assert.equal(parseKvCreateOutput({ stdout: 'id = "0123456789abcdef0123456789abcdef"', stderr: '' }), '0123456789abcdef0123456789abcdef');
  assert.equal(parseKvCreateOutput({ stdout: '{"id":"fedcba9876543210fedcba9876543210"}', stderr: '' }), 'fedcba9876543210fedcba9876543210');
  assert.equal(parseDeployOutput({ stdout: 'Published at https://hearth-dash.example.workers.dev', stderr: '' }), 'https://hearth-dash.example.workers.dev');
});

test('returns null rather than inventing missing Cloudflare identifiers', () => {
  assert.equal(parseD1CreateOutput({ stdout: 'created', stderr: '' }), null);
  assert.equal(parseKvCreateOutput({ stdout: 'created', stderr: '' }), null);
  assert.equal(parseDeployOutput({ stdout: 'deployed', stderr: '' }), null);
});
