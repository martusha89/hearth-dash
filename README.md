<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:8B5CF6,100:22D3EE&height=170&section=header&text=Hearth&fontColor=ffffff&fontSize=50&fontAlignY=40&desc=A%20cozy%20personal%20dashboard%20on%20Cloudflare%20Workers&descSize=17&descAlignY=64" width="100%" />

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](#)
[![D1](https://img.shields.io/badge/D1-SQLite-22D3EE?style=for-the-badge&logo=cloudflare&logoColor=white)](#)
[![license MIT](https://img.shields.io/badge/license-MIT-A855F7?style=for-the-badge)](LICENSE)

</div>

Hearth is a small, cozy personal dashboard for two people, built as a single Cloudflare Worker with embedded HTML, CSS, and vanilla JavaScript on top of a D1 (SQLite) database. It tracks the soft, shared parts of daily life (moods, notes, moments, dates, a shopping list, a food and water diary, and barometric pressure with a migraine alert) behind a password-protected login. Everything is also exposed over a simple MCP endpoint so an assistant like Claude can read and write the same data.

## Features

- **Dashboard overview**: an at-a-glance home tab pulling the latest mood for each partner, the most recent note, the next upcoming date, the open shopping count, and today's meals and water total.
- **Moods**: log a mood (with an optional note) for either partner and view recent history.
- **Notes**: leave short notes for each other and read the recent thread.
- **Moments**: a dated timeline of memories with a title and optional description.
- **Dates**: upcoming important dates, with support for recurring entries.
- **Shopping list**: add items by category, check them off, grouped by category.
- **Food diary**: log meals by type (breakfast, lunch, dinner, and more) with notes and an optional photo (stored in Cloudflare R2), plus daily food reviews.
- **Water tracking**: log water intake in millilitres against a daily target, summarised as glasses.
- **Barometric pressure and migraine alerts**: pulls current pressure and forecast from OpenWeatherMap, opportunistically logs readings to D1, charts history, and computes a watch/warning/critical alert from 6-hour and 24-hour pressure shifts.
- **Weather**: a current-conditions endpoint backing the pressure tracking.
- **Password-protected access**: set a dashboard password via env var or on first visit through the setup page, with cookie-based sessions.
- **Two-partner setup**: partner names are configurable, so the whole dashboard reads as "yours" rather than generic.
- **MCP server**: a secret-scoped `/mcp/` endpoint exposing tools (`hearth_status`, `hearth_mood`, `hearth_note`, `hearth_moment`, `hearth_date`, `hearth_shopping_list`, `hearth_shopping_add`, `hearth_pressure`, `hearth_food_diary_today`, `hearth_food_diary_history`, `hearth_food_review`, `hearth_water_status`) so an assistant can read and update the dashboard.
- **CLI**: an `hearth-dash` command (`deploy`, `mcp`, `config`) to deploy to Cloudflare and print MCP configuration for Claude Code or Claude Desktop.

## Deploy

```bash
# Install Wrangler is not required, the scripts use npx

# 1. Create a D1 database and put its id into wrangler.toml (database_id)
npx wrangler d1 create hearth-dash-db

# 2. Initialise the database schema
npm run db:init           # local
npm run db:init:remote    # remote (Cloudflare)

# 3. Set secrets (or set the password later on the first-visit setup page)
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put MCP_SECRET
npx wrangler secret put WEATHER_API_KEY

# 4. Run locally
npm run dev               # npx wrangler dev

# 5. Deploy to Cloudflare Workers
npm run deploy            # npx wrangler deploy
```

You can also use the bundled CLI:

```bash
npx hearth-dash deploy    # deploy to Cloudflare (Workers + D1 + R2)
npx hearth-dash mcp       # print MCP config for Claude Code/Desktop
npx hearth-dash config    # view current configuration
```

Configuration lives in `wrangler.toml`: partner names under `[vars]` (`PARTNER_1`, `PARTNER_2`), the D1 binding (`DB`), the R2 bucket binding for food photos (`PHOTOS`), and optional `WEATHER_LAT` / `WEATHER_LON`. An OpenWeatherMap API key (free tier works) is needed for weather and pressure features.

## Stack

Cloudflare Workers (single-file `worker.js`), D1 (SQLite), R2 for photo storage, OpenWeatherMap API, vanilla HTML/CSS/JS frontend, a Node.js CLI, and an MCP endpoint. Requires Node.js 18+.

## License

MIT. See [LICENSE](LICENSE).
