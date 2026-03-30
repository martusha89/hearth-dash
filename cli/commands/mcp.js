import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { banner, bold, dim, cyan, warn, info } from "../lib/ui.js";

const CONFIG_PATH = join(homedir(), ".hearth-dash", "config.json");

export default async function mcpCommand(args) {
  banner();

  if (!existsSync(CONFIG_PATH)) {
    warn("No config found. Run 'hearth-dash deploy' first.");
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  const mcpUrl = config.workerUrl + "/mcp/" + config.mcpSecret;

  console.log(bold("  MCP Configuration\n"));

  console.log(`  ${bold("Endpoint:")} ${cyan(mcpUrl)}\n`);

  console.log(`  ${bold("For Claude Code")} (add to ${dim("~/.claude.json")}):\n`);
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "hearth-dash": {`);
  console.log(`        "url": "${mcpUrl}"`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }\n`);

  console.log(`  ${bold("For Claude Desktop")} (Settings > Developer > MCP):\n`);
  console.log(`  Name:     hearth-dash`);
  console.log(`  URL:      ${mcpUrl}\n`);

  console.log(`  ${bold("Connector URL")} (for Claude.ai mobile):`);
  console.log(`  ${cyan(mcpUrl)}\n`);

  console.log(`  ${bold("Available MCP tools:")}`);
  const tools = [
    "hearth_status       — Dashboard overview",
    "hearth_mood         — Get/set moods",
    "hearth_note         — Get/leave fridge notes",
    "hearth_moment       — List/add moments",
    "hearth_date         — Upcoming/add dates",
    "hearth_shopping_list — Get shopping list",
    "hearth_shopping_add — Add shopping item",
    "hearth_pressure     — Barometric pressure data",
    "hearth_food_diary_today    — Today's meals + water",
    "hearth_food_diary_history  — Historical food data",
    "hearth_food_review  — Post food review",
    "hearth_water_status — Water intake status",
  ];
  tools.forEach(t => console.log(`    ${dim(t)}`));
  console.log();

  if (args.includes("--install")) {
    const { writeFileSync } = await import("node:fs");
    const claudeConfigPath = join(homedir(), ".claude.json");
    let claudeConfig = {};
    if (existsSync(claudeConfigPath)) {
      try { claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8")); } catch {}
    }
    if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
    claudeConfig.mcpServers["hearth-dash"] = { url: mcpUrl };
    writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2) + "\n", "utf-8");
    info("MCP config written to " + claudeConfigPath);
  }
}
