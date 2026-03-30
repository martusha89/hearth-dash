import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { banner, bold, dim, cyan, warn } from "../lib/ui.js";

const CONFIG_PATH = join(homedir(), ".hearth-dash", "config.json");

export default async function configCommand(args) {
  banner();

  if (!existsSync(CONFIG_PATH)) {
    warn("No config found. Run 'hearth-dash deploy' first.");
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

  console.log(bold("  Current Configuration\n"));
  console.log(`  ${bold("Dashboard URL:")}  ${cyan(config.workerUrl || "not set")}`);
  console.log(`  ${bold("Partner 1:")}      ${config.partner1 || "not set"}`);
  console.log(`  ${bold("Partner 2:")}      ${config.partner2 || "not set"}`);
  console.log(`  ${bold("Database ID:")}    ${config.dbId ? config.dbId.substring(0, 8) + "..." : "not set"}`);
  console.log(`  ${bold("MCP Secret:")}     ${config.mcpSecret ? config.mcpSecret.substring(0, 6) + "..." : "not set"}`);
  console.log(`  ${bold("Deployed:")}       ${config.deployedAt || "never"}`);
  console.log(`\n  ${dim("Config file: " + CONFIG_PATH)}\n`);
}
