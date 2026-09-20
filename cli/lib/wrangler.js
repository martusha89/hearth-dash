import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

function spawnCmd(cmd, args, opts) {
  if (process.platform === "win32") {
    const full = [cmd, ...args].map((a) => a.includes(" ") ? `"${a}"` : a).join(" ");
    return spawn(full, [], { ...opts, shell: true });
  }
  return spawn(cmd, args, opts);
}

export function execWrangler(args, cwd, stdinData) {
  return new Promise((resolve) => {
    const proc = spawnCmd("npx", ["wrangler", ...args], {
      cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    if (stdinData) { proc.stdin.write(stdinData); proc.stdin.end(); }
    else { proc.stdin.end(); }
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

export function execCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const proc = spawnCmd(command, args, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

export function parseD1CreateOutput(output) {
  const combined = output.stdout + "\n" + output.stderr;
  const match = combined.match(/database_id\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export function parseDeployOutput(output) {
  const combined = output.stdout + "\n" + output.stderr;
  const match = combined.match(/https:\/\/[^\s)]+\.workers\.dev/);
  return match ? match[0] : null;
}

export async function checkWranglerAuth(cwd) {
  const result = await execWrangler(["whoami"], cwd);
  if (result.code !== 0) return false;
  const combined = result.stdout + result.stderr;
  return !combined.includes("Not logged in") && !combined.includes("not authenticated");
}

export async function wranglerLogin(cwd) {
  return new Promise((resolve) => {
    const proc = spawnCmd("npx", ["wrangler", "login"], { cwd, stdio: "inherit" });
    proc.on("close", (code) => resolve(code === 0));
  });
}

export async function setSecret(name, value, cwd) {
  return execWrangler(["secret", "put", name], cwd, value + "\n");
}

export async function executeSchema(dbName, schemaPath, cwd) {
  const result = await execWrangler(["d1", "execute", dbName, "--remote", "--file=" + schemaPath], cwd);
  if (result.code === 0) return { ok: true };
  const sql = readFileSync(schemaPath, "utf-8");
  const statements = sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of statements) {
    const r = await execWrangler(["d1", "execute", dbName, "--remote", "--command", stmt + ";"], cwd);
    if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  }
  return { ok: true };
}

export function hasRequiredSchemaTables(output, requiredTables) {
  try {
    const parsed = JSON.parse(output);
    const envelopes = Array.isArray(parsed) ? parsed : [parsed];
    const names = new Set(envelopes.flatMap(item => item?.results || []).map(row => row.name));
    return requiredTables.every(name => names.has(name));
  } catch {
    return false;
  }
}

export function hasRequiredOAuthCsrfColumns(output) {
  try {
    const parsed = JSON.parse(output);
    const envelopes = Array.isArray(parsed) ? parsed : [parsed];
    const columns = new Map(envelopes.flatMap(item => item?.results || []).map(row => [row.name, row]));
    const token = columns.get('token');
    const fingerprint = columns.get('request_fingerprint');
    const expires = columns.get('expires_at');
    return columns.size === 3
      && String(token?.type).toUpperCase() === 'TEXT' && Number(token?.pk) === 1
      && String(fingerprint?.type).toUpperCase() === 'TEXT' && Number(fingerprint?.notnull) === 1
      && String(expires?.type).toUpperCase() === 'INTEGER' && Number(expires?.notnull) === 1;
  } catch {
    return false;
  }
}

export async function verifySecuritySchema(dbName, cwd) {
  const requiredTables = ['rate_limits', 'oauth_csrf_tokens'];
  const quoted = requiredTables.map(name => `'${name.replaceAll("'", "''")}'`).join(', ');
  const query = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${quoted}) ORDER BY name;`;
  const tables = await execWrangler(['d1', 'execute', dbName, '--remote', '--command', query, '--json'], cwd);
  if (tables.code !== 0 || !hasRequiredSchemaTables(tables.stdout, requiredTables)) return false;
  const columns = await execWrangler([
    'd1', 'execute', dbName, '--remote', '--command', 'PRAGMA table_info(oauth_csrf_tokens);', '--json',
  ], cwd);
  return columns.code === 0 && hasRequiredOAuthCsrfColumns(columns.stdout);
}

export async function provisionAfterVerifiedSchema({ applySchema, verifySchema, provisionWorker, onSchemaVerified = () => {} }) {
  const schemaResult = await applySchema();
  if (!schemaResult.ok) return { ok: false, stage: 'schema', schemaResult };
  const schemaVerified = await verifySchema();
  if (!schemaVerified) return { ok: false, stage: 'verification', schemaResult };
  onSchemaVerified();
  const provisionResult = await provisionWorker();
  return { ok: provisionResult.code === 0, stage: 'provision', schemaResult, provisionResult };
}

export async function listD1Databases(cwd) {
  const result = await execWrangler(["d1", "list", "--json"], cwd);
  if (result.code !== 0) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}

export async function listKvNamespaces(cwd) {
  const result = await execWrangler(['kv', 'namespace', 'list'], cwd);
  if (result.code !== 0) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}

export function parseKvCreateOutput(output) {
  const combined = output.stdout + '\n' + output.stderr;
  const toml = combined.match(/id\s*=\s*"([a-f0-9]{32})"/i);
  if (toml) return toml[1];
  const json = combined.match(/"id"\s*:\s*"([a-f0-9]{32})"/i);
  return json ? json[1] : null;
}
