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

export async function listD1Databases(cwd) {
  const result = await execWrangler(["d1", "list", "--json"], cwd);
  if (result.code !== 0) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}
