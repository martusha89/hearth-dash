import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { getPackageRoot, getNodeMajor } from "../lib/platform.js";
import { ask, confirm, password } from "../lib/prompts.js";
import {
  execWrangler, parseD1CreateOutput, parseDeployOutput,
  checkWranglerAuth, wranglerLogin, setSecret, executeSchema, listD1Databases,
} from "../lib/wrangler.js";
import { banner, step, bold, dim, cyan, green, yellow, red, success, fail, warn, info, spinner } from "../lib/ui.js";

const TOTAL_STEPS = 6;
const CONFIG_DIR = join(homedir(), ".hearth-dash");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function saveConfig(data) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let existing = {};
  if (existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}
  }
  const merged = { ...existing, ...data };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

function genSecret() {
  return randomBytes(16).toString("base64url");
}

async function createD1OrReuse(dbName, cwd) {
  const result = await execWrangler(["d1", "create", dbName], cwd);
  if (result.code === 0) return parseD1CreateOutput(result);
  const combined = result.stdout + result.stderr;
  if (combined.includes("already exists") || combined.includes("already a database")) {
    warn(`Database "${dbName}" already exists. Looking up ID...`);
    const databases = await listD1Databases(cwd);
    const db = databases.find((d) => d.name === dbName);
    if (db) { info(`Found: ${db.uuid}`); return db.uuid; }
    fail("Could not find existing database ID.");
    return null;
  }
  fail(`Failed to create database: ${combined}`);
  return null;
}

export default async function deployCommand(args) {
  banner();
  console.log(bold("  Full Cloudflare Deployment\n"));

  // ── Step 1: Preflight ────────────────────────────────────

  step(1, TOTAL_STEPS, "Preflight checks");

  const nodeMajor = getNodeMajor();
  if (nodeMajor < 18) { fail(`Node.js ${nodeMajor} detected. Need >= 18.`); process.exit(1); }
  success(`Node.js ${process.version}`);

  const wranglerCheck = await execWrangler(["--version"], ".");
  if (wranglerCheck.code !== 0) {
    fail("Wrangler not found. Install: npm install -g wrangler");
    process.exit(1);
  }
  success(`Wrangler installed`);

  const authed = await checkWranglerAuth(".");
  if (!authed) {
    warn("Not logged into Cloudflare. Opening browser...");
    const loginOk = await wranglerLogin(".");
    if (!loginOk) { fail("Cloudflare login failed."); process.exit(1); }
  }
  success("Cloudflare authenticated");

  // ── Step 2: Configuration ────────────────────────────────

  step(2, TOTAL_STEPS, "Configuration");

  const partner1 = await ask("  Partner 1 name", "Partner 1");
  const partner2 = await ask("  Partner 2 name (or AI name)", "AI");
  const dashPassword = await password("  Dashboard password");
  if (!dashPassword) { fail("Password is required."); process.exit(1); }
  const mcpSecret = genSecret();
  success("MCP secret generated");

  console.log();
  info("Weather requires a free OpenWeatherMap API key.");
  info("Get one at: https://openweathermap.org/api");
  const weatherKey = await ask("  OpenWeatherMap API key (or skip)");
  let weatherLat = "", weatherLon = "";
  if (weatherKey) {
    info("Find your coordinates at: https://www.latlong.net");
    weatherLat = await ask("  Latitude (e.g. 51.5074)", "51.5074");
    weatherLon = await ask("  Longitude (e.g. -0.1278)", "-0.1278");
  }

  // ── Step 3: Create D1 database ───────────────────────────

  step(3, TOTAL_STEPS, "Creating D1 database");

  const pkgRoot = getPackageRoot();
  const deployDir = join(CONFIG_DIR, "deploy");
  mkdirSync(deployDir, { recursive: true });

  // Copy worker files to deploy dir
  const s1 = spinner("Copying source files");
  for (const file of ["worker.js", "schema.sql", "wrangler.toml"]) {
    const src = join(pkgRoot, file);
    if (!existsSync(src)) { s1.fail(`Missing: ${file}`); process.exit(1); }
    writeFileSync(join(deployDir, file), readFileSync(src, "utf-8"), "utf-8");
  }
  s1.stop("Source files copied");

  const s2 = spinner("Creating D1 database");
  const dbId = await createD1OrReuse("hearth-dash-db", deployDir);
  if (!dbId) { s2.fail("D1 creation failed"); process.exit(1); }
  s2.stop(`D1 database ready: ${dbId.substring(0, 8)}...`);

  // ── Step 4: Create R2 bucket ─────────────────────────────

  step(4, TOTAL_STEPS, "Creating R2 bucket");

  const s3 = spinner("Creating R2 bucket");
  const r2Result = await execWrangler(["r2", "bucket", "create", "hearth-dash-photos"], deployDir);
  if (r2Result.code !== 0) {
    const combined = r2Result.stdout + r2Result.stderr;
    if (combined.includes("already exists")) {
      s3.stop("R2 bucket already exists");
    } else {
      s3.fail(`R2 creation failed: ${combined}`);
      process.exit(1);
    }
  } else {
    s3.stop("R2 bucket created");
  }

  // Patch wrangler.toml with real values
  let toml = readFileSync(join(deployDir, "wrangler.toml"), "utf-8");
  toml = toml.replace("YOUR_D1_DATABASE_ID", dbId);
  toml = toml.replace('PARTNER_1 = "Partner 1"', `PARTNER_1 = "${partner1}"`);
  toml = toml.replace('PARTNER_2 = "Partner 2"', `PARTNER_2 = "${partner2}"`);
  if (weatherLat) {
    toml = toml.replace('# WEATHER_LAT = "52.5726"', `WEATHER_LAT = "${weatherLat}"`);
    toml = toml.replace('# WEATHER_LON = "-0.2405"', `WEATHER_LON = "${weatherLon}"`);
  }
  writeFileSync(join(deployDir, "wrangler.toml"), toml, "utf-8");

  // ── Step 5: Deploy worker + set secrets ──────────────────

  step(5, TOTAL_STEPS, "Deploying worker");

  const s4 = spinner("Setting secrets");
  await setSecret("DASHBOARD_PASSWORD", dashPassword, deployDir);
  await setSecret("MCP_SECRET", mcpSecret, deployDir);
  if (weatherKey) await setSecret("WEATHER_API_KEY", weatherKey, deployDir);
  s4.stop("Secrets configured");

  const s5 = spinner("Deploying to Cloudflare Workers");
  const deployResult = await execWrangler(["deploy"], deployDir);
  if (deployResult.code !== 0) {
    s5.fail("Deploy failed");
    console.error(deployResult.stderr || deployResult.stdout);
    process.exit(1);
  }
  const workerUrl = parseDeployOutput(deployResult);
  s5.stop(`Deployed: ${workerUrl}`);

  // Init schema
  const s6 = spinner("Initializing database schema");
  const schemaResult = await executeSchema("hearth-dash-db", join(deployDir, "schema.sql"), deployDir);
  if (!schemaResult.ok) {
    s6.fail("Schema init failed: " + (schemaResult.error || "unknown error"));
    warn("You can retry manually: npx wrangler d1 execute hearth-dash-db --remote --file schema.sql");
  } else {
    s6.stop("Database schema initialized");
  }

  // ── Step 6: Save config + print results ──────────────────

  step(6, TOTAL_STEPS, "Finishing up");

  const config = saveConfig({
    workerUrl,
    mcpSecret,
    partner1,
    partner2,
    dbId,
    deployedAt: new Date().toISOString(),
  });

  const mcpUrl = workerUrl + "/mcp/" + mcpSecret;

  console.log(`
${green(bold("  Done!"))} Your dashboard is live.

  ${bold("Dashboard:")}  ${cyan(workerUrl)}
  ${bold("Password:")}   ${dim("(the one you just set)")}

  ${bold("MCP Endpoint:")}
  ${dim(mcpUrl)}

  ${bold("MCP Config")} (add to Claude Code ${dim("~/.claude.json")} or Claude Desktop):
${dim("  {")}
${dim('    "mcpServers": {')}
${dim('      "hearth-dash": {')}
${dim('        "url": "' + mcpUrl + '"')}
${dim("      }")}
${dim("    }")}
${dim("  }")}

  ${bold("Connector URL")} (for Claude.ai mobile):
  ${cyan(mcpUrl)}

  ${dim("Config saved to: " + CONFIG_PATH)}
`);
}
