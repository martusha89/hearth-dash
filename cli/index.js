#!/usr/bin/env node

import { bold, dim, magenta, cyan } from "./lib/ui.js";

const [,, command, ...args] = process.argv;

const COMMANDS = {
  deploy: () => import("./commands/deploy.js"),
  mcp:    () => import("./commands/mcp.js"),
  config: () => import("./commands/config.js"),
};

async function main() {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getPackageRoot } = await import("./lib/platform.js");
    try {
      const pkg = JSON.parse(readFileSync(join(getPackageRoot(), "package.json"), "utf-8"));
      console.log(pkg.version);
    } catch { console.log("unknown"); }
    process.exit(0);
  }

  const loader = COMMANDS[command];
  if (!loader) {
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
  }

  const mod = await loader();
  await mod.default(args);
}

function printHelp() {
  console.log(`
${magenta(bold("HEARTH DASH"))} ${dim("— Personal dashboard")}

${bold("Usage:")} hearth-dash <command> [options]

${bold("Commands:")}
  ${cyan("deploy")}    Deploy to Cloudflare (Workers + D1 + R2)
  ${cyan("mcp")}       Print MCP config for Claude Code/Desktop
  ${cyan("config")}    View current configuration

${bold("Quick start:")}
  ${dim("$")} npx hearth-dash deploy
  ${dim("$")} npx hearth-dash mcp

${bold("Requirements:")}
  - Node.js 18+
  - Cloudflare account (free tier works)
  - OpenWeatherMap API key (free at ${dim("https://openweathermap.org/api")})
`);
}

main();
