/**
 * Hearth Dash — Personal Dashboard
 * Cloudflare Worker with D1 Database + R2 Photos + MCP Endpoint
 *
 * Deploy: npx wrangler deploy
 * Docs: https://github.com/martusha89/hearth-dash
 */

const encoder = new TextEncoder();
const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
const MAX_JSON_BODY_BYTES = 64 * 1024;

function getConfig(env) {
  return {
    PASSWORD: env.DASHBOARD_PASSWORD || null,
    SESSION_SECRET: env.SESSION_SECRET || null,
    MCP_ALLOWED_ORIGINS: (env.MCP_ALLOWED_ORIGINS || 'https://claude.ai')
      .split(',').map(value => value.trim()).filter(Boolean),
    PARTNER_1: env.PARTNER_1 || 'Partner 1',
    PARTNER_2: env.PARTNER_2 || 'Partner 2',
  };
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function safeEqual(left, right) {
  const leftDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(left || ''))));
  const rightDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(right || ''))));
  let mismatch = 0;
  for (let i = 0; i < leftDigest.length; i++) mismatch |= leftDigest[i] ^ rightDigest[i];
  return mismatch === 0;
}

async function createSession(secret) {
  const payload = base64Url(encoder.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    nonce: crypto.randomUUID(),
  })));
  return payload + '.' + base64Url(await hmac(secret, payload));
}

async function verifySession(token, secret) {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  try {
    const expected = base64Url(await hmac(secret, parts[0]));
    if (!(await safeEqual(parts[1], expected))) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    return Number.isFinite(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://openweathermap.org; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

function sessionCookie(value, maxAge = 604800) {
  return `__Host-hearth_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

export async function withinRateLimit(env, request, scope, limit, windowSeconds) {
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(address)));
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const key = `${scope}:${windowStart}:${base64Url(digest).slice(0, 24)}`;
  try {
    await env.DB.prepare(
      'INSERT INTO rate_limits (bucket_key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1'
    ).bind(key, windowStart + windowSeconds * 2).run();
    const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket_key = ?').bind(key).first();
    if (Math.random() < 0.01) env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < unixepoch('now')").run().catch(() => {});
    return !row || row.count <= limit;
  } catch {
    // Authentication and authorization endpoints must not silently lose their
    // abuse controls when D1 or the additive migration is unavailable.
    return false;
  }
}

function getSetupPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hearth Dash — Welcome</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f0f1a; color: #fafafa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .setup-box { background: #1a1a2e; padding: 3rem; border-radius: 16px; text-align: center; max-width: 440px; width: 90%; border: 1px solid rgba(192,132,252,0.2); }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; font-weight: 600; background: linear-gradient(135deg, #c084fc, #2dd4bf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #71717a; margin-bottom: 2rem; }
    input[type="password"] { width: 100%; padding: 1rem; border: 1px solid #2a2a3e; border-radius: 10px; background: #0f0f1a; color: #fafafa; font-family: inherit; font-size: 1rem; margin-bottom: 0.75rem; }
    input[type="password"]:focus { outline: none; border-color: #c084fc; box-shadow: 0 0 0 3px rgba(192,132,252,0.15); }
    button { width: 100%; padding: 1rem; border: none; border-radius: 10px; background: linear-gradient(135deg, #c084fc, #a855f7); color: white; font-family: inherit; font-size: 1rem; cursor: pointer; font-weight: 600; }
    button:hover { background: linear-gradient(135deg, #d8b4fe, #c084fc); }
    .error { color: #f87171; margin-bottom: 1rem; }
    .note { color: #52525b; font-size: 0.8rem; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <div class="setup-box">
    <h1>Hearth Dash</h1>
    <p class="subtitle">Welcome! Create a password to get started.</p>
    ${error || ''}
    <form method="POST" action="/setup">
      <input type="password" name="password" placeholder="Choose a password" autofocus required minlength="4">
      <input type="password" name="confirm" placeholder="Confirm password" required minlength="4">
      <button type="submit">Create Dashboard</button>
    </form>
    <p class="note">This password protects your dashboard. Remember it!</p>
  </div>
</body>
</html>`;
}

function getLoginPage(config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hearth Dash</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f0f1a; color: #fafafa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-box { background: #1a1a2e; padding: 3rem; border-radius: 16px; text-align: center; max-width: 400px; width: 90%; border: 1px solid rgba(192,132,252,0.2); }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; font-weight: 600; background: linear-gradient(135deg, #c084fc, #2dd4bf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #71717a; margin-bottom: 2rem; }
    input[type="password"] { width: 100%; padding: 1rem; border: 1px solid #2a2a3e; border-radius: 10px; background: #0f0f1a; color: #fafafa; font-family: inherit; font-size: 1rem; margin-bottom: 1rem; }
    input[type="password"]:focus { outline: none; border-color: #c084fc; box-shadow: 0 0 0 3px rgba(192,132,252,0.15); }
    button { width: 100%; padding: 1rem; border: none; border-radius: 10px; background: linear-gradient(135deg, #c084fc, #a855f7); color: white; font-family: inherit; font-size: 1rem; cursor: pointer; font-weight: 600; }
    button:hover { background: linear-gradient(135deg, #d8b4fe, #c084fc); }
    .error { color: #f87171; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Hearth Dash</h1>
    <p class="subtitle">Your personal dashboard</p>
    {{ERROR}}
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Enter</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function getDashboardHTML(config) {
  const P1 = config.PARTNER_1;
  const P2 = config.PARTNER_2;
  const P1HTML = escapeHtml(P1);
  const P2HTML = escapeHtml(P2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hearth Dash</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f0f1a; color: #fafafa; min-height: 100vh; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #2a2a3e; flex-wrap: wrap; gap: 0.5rem; }
    h1 { font-size: 1.75rem; font-weight: 600; background: linear-gradient(135deg, #c084fc, #2dd4bf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    nav { display: flex; flex-wrap: wrap; gap: 0.25rem; }
    nav a { color: #71717a; text-decoration: none; padding: 0.25rem 0.75rem; border-radius: 6px; font-size: 0.9rem; transition: all 0.2s; }
    nav a:hover, nav a.active { color: #c084fc; background: rgba(192,132,252,0.1); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; }
    .card { background: #1a1a2e; border-radius: 14px; padding: 1.5rem; border: 1px solid #2a2a3e; }
    .card h2 { font-size: 0.85rem; color: #71717a; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; font-weight: 600; }
    .mood-display { display: flex; gap: 2rem; }
    .mood-person { flex: 1; }
    .mood-person h3 { font-size: 0.875rem; color: #52525b; margin-bottom: 0.5rem; }
    .mood-value { font-size: 1.5rem; }
    .mood-time { font-size: 0.75rem; color: #52525b; margin-top: 0.25rem; }
    .note-card { background: rgba(192,132,252,0.08); color: #e5e7eb; padding: 1rem; border-radius: 10px; font-style: italic; margin-bottom: 0.75rem; border: 1px solid rgba(192,132,252,0.15); }
    .note-meta { font-size: 0.75rem; color: #71717a; margin-top: 0.5rem; font-style: normal; }
    .moment-item { padding: 0.75rem 0; border-bottom: 1px solid #2a2a3e; }
    .moment-item:last-child { border-bottom: none; }
    .moment-date { font-size: 0.75rem; color: #71717a; }
    .countdown { font-size: 2rem; color: #c084fc; font-weight: 700; }
    .countdown-label { font-size: 0.875rem; color: #71717a; }
    input, select, textarea { padding: 0.75rem; border: 1px solid #2a2a3e; border-radius: 10px; background: #0f0f1a; color: #fafafa; font-family: inherit; font-size: 0.875rem; width: 100%; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #c084fc; box-shadow: 0 0 0 3px rgba(192,132,252,0.15); }
    textarea { resize: vertical; min-height: 80px; }
    .btn { padding: 0.75rem 1.5rem; border: none; border-radius: 10px; background: linear-gradient(135deg, #c084fc, #a855f7); color: white; font-family: inherit; cursor: pointer; font-size: 0.875rem; font-weight: 600; }
    .btn:hover { background: linear-gradient(135deg, #d8b4fe, #c084fc); }
    .btn-ghost { background: transparent; border: 1px solid #2a2a3e; color: #71717a; }
    .btn-ghost:hover { border-color: #c084fc; color: #c084fc; }
    .empty { color: #52525b; font-style: italic; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Weather */
    .weather-main { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem; }
    .weather-temp { font-size: 2rem; font-weight: bold; }
    .weather-desc { color: #71717a; text-transform: capitalize; }
    .weather-details { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; font-size: 0.85rem; color: #d4d4d8; }
    .weather-details span { display: flex; justify-content: space-between; }
    .weather-details .label { color: #71717a; }
    .migraine-alert { margin-top: 0.75rem; padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.8rem; }
    .migraine-alert.low { background: rgba(45,212,191,0.1); border: 1px solid rgba(45,212,191,0.3); color: #5eead4; }
    .migraine-alert.moderate { background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.3); color: #facc15; }
    .migraine-alert.high { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; }
    .shift-alert { margin-top: 0.5rem; padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.8rem; display: flex; align-items: center; gap: 0.5rem; }
    .shift-alert.watch { background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.3); color: #facc15; }
    .shift-alert.warning { background: rgba(192,132,252,0.1); border: 1px solid rgba(192,132,252,0.3); color: #d8b4fe; }
    .shift-alert.critical { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4); color: #fca5a5; }
    .shift-arrow { font-size: 1.2rem; font-weight: bold; }

    /* Pressure */
    .pressure-canvas { width: 100%; height: 280px; display: block; background: #0f0f1a; border: 1px solid #2a2a3e; border-radius: 10px; }
    .pressure-legend { display: flex; gap: 1.5rem; margin-top: 0.5rem; font-size: 0.75rem; color: #71717a; }
    .pressure-legend span::before { content: ''; display: inline-block; width: 12px; height: 3px; margin-right: 0.35rem; vertical-align: middle; border-radius: 2px; }
    .pressure-legend .leg-hist::before { background: #2dd4bf; }
    .pressure-legend .leg-forecast::before { background: #2dd4bf; opacity: 0.5; }
    .pressure-legend .leg-now::before { background: #c084fc; }
    .pressure-legend .leg-watch::before { background: rgba(234,179,8,0.35); width: 12px; height: 8px; }
    .pressure-legend .leg-warn::before { background: rgba(192,132,252,0.35); width: 12px; height: 8px; }
    .pressure-legend .leg-crit::before { background: rgba(239,68,68,0.35); width: 12px; height: 8px; }
    .pressure-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-bottom: 1rem; }
    @media (max-width: 600px) { .pressure-stats { grid-template-columns: 1fr; } }
    .pressure-stat { background: #0f0f1a; border: 1px solid #2a2a3e; border-radius: 10px; padding: 0.85rem; }
    .pressure-stat-label { font-size: 0.7rem; color: #71717a; text-transform: uppercase; letter-spacing: 0.04em; }
    .pressure-stat-value { font-size: 1.3rem; font-weight: bold; margin-top: 0.25rem; }

    /* Shopping */
    .shop-category { font-size: 0.8rem; color: #c084fc; text-transform: uppercase; letter-spacing: 0.05em; margin: 1rem 0 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid #2a2a3e; }
    .shop-category:first-child { margin-top: 0; }
    .shop-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid rgba(42,42,62,0.6); }
    .shop-item:last-child { border-bottom: none; }
    .shop-item.checked { opacity: 0.4; }
    .shop-item.checked .shop-text { text-decoration: line-through; }
    .shop-check { appearance: none; width: 20px; height: 20px; border-radius: 50%; border: 2px solid #2a2a3e; cursor: pointer; flex-shrink: 0; position: relative; }
    .shop-check:checked { border-color: #2dd4bf; background: #2dd4bf; }
    .shop-check:checked::after { content: '\\2713'; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); color: #0f0f1a; font-size: 0.7rem; font-weight: bold; }
    .shop-text { flex: 1; }
    .shop-by { font-size: 0.7rem; color: #71717a; }
    .shop-del { background: none; border: none; color: #52525b; cursor: pointer; font-size: 0.9rem; padding: 0.25rem; }
    .shop-del:hover { color: #f87171; }
    .shop-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
    .shop-count { font-size: 1.5rem; font-weight: bold; color: #c084fc; }

    /* Food Diary */
    .fd-grid { display: grid; grid-template-columns: 380px 1fr; gap: 1.5rem; }
    @media (max-width: 900px) { .fd-grid { grid-template-columns: 1fr; } }
    .fd-meal-card { background: #0f0f1a; border: 1px solid #2a2a3e; border-radius: 10px; padding: 1rem; margin-bottom: 0.75rem; display: flex; gap: 1rem; align-items: start; }
    .fd-meal-card img { width: 80px; height: 80px; object-fit: cover; border-radius: 8px; flex-shrink: 0; cursor: pointer; }
    .fd-meal-card img.fd-expanded { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); width: auto; height: auto; max-width: 90vw; max-height: 90vh; z-index: 1000; border-radius: 12px; box-shadow: 0 0 40px rgba(0,0,0,0.8); }
    .fd-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 999; display: none; }
    .fd-meal-info { flex: 1; }
    .fd-meal-type { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: #c084fc; font-weight: 600; }
    .fd-meal-time { font-size: 0.7rem; color: #71717a; }
    .fd-meal-note { font-size: 0.85rem; color: #d4d4d8; margin-top: 0.25rem; }
    .fd-water-bar { height: 24px; background: #2a2a3e; border-radius: 12px; overflow: hidden; margin: 0.75rem 0; position: relative; }
    .fd-water-fill { height: 100%; background: linear-gradient(90deg, #2dd4bf, #14b8a6); border-radius: 12px; transition: width 0.4s ease; }
    .fd-water-label { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); font-size: 0.75rem; font-weight: 600; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
    .fd-water-btns { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .fd-water-btn { padding: 0.5rem 1rem; border: 1px solid #2a2a3e; border-radius: 8px; background: #0f0f1a; color: #2dd4bf; cursor: pointer; font-family: inherit; font-size: 0.85rem; transition: all 0.15s; }
    .fd-water-btn:hover { border-color: #2dd4bf; background: rgba(45,212,191,0.1); }
    .fd-water-total { font-size: 1.3rem; font-weight: bold; color: #2dd4bf; }
    .fd-water-target { font-size: 0.8rem; color: #71717a; }
    .fd-review-card { background: rgba(192,132,252,0.06); border: 1px solid rgba(192,132,252,0.2); border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
    .fd-review-card .fd-review-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
    .fd-review-card .fd-review-name { color: #c084fc; font-weight: 700; font-size: 0.95rem; }
    .fd-review-card .fd-review-label { font-size: 0.7rem; color: #71717a; text-transform: uppercase; letter-spacing: 0.04em; }
    .fd-review-card .fd-review-text { font-size: 0.9rem; color: #e5e7eb; line-height: 1.6; }
    .fd-review-card .fd-review-date { font-size: 0.7rem; color: #71717a; margin-top: 0.75rem; }
    .fd-review-card.empty-review { border-style: dashed; opacity: 0.6; }
    .fd-review-card.empty-review .fd-review-text { color: #71717a; font-style: italic; }
    .fd-patterns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-bottom: 1rem; }
    @media (max-width: 600px) { .fd-patterns { grid-template-columns: 1fr; } }
    .fd-pattern { background: #0f0f1a; border: 1px solid #2a2a3e; border-radius: 10px; padding: 0.85rem; }
    .fd-pattern-label { font-size: 0.7rem; color: #71717a; text-transform: uppercase; letter-spacing: 0.04em; }
    .fd-pattern-value { font-size: 1.3rem; font-weight: bold; margin-top: 0.25rem; }
    .fd-photo-preview { max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 0.5rem; display: none; }
    .fd-upload-area { border: 2px dashed #2a2a3e; border-radius: 8px; padding: 1rem; text-align: center; color: #71717a; font-size: 0.85rem; cursor: pointer; margin-bottom: 0.5rem; transition: border-color 0.2s; }
    .fd-upload-area:hover { border-color: #c084fc; }
    .fd-upload-area.has-file { border-color: #2dd4bf; border-style: solid; }
    .fd-week-day { display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid rgba(42,42,62,0.6); font-size: 0.8rem; }
    .fd-week-day:last-child { border-bottom: none; }
    .fd-meal-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .fd-meal-dot.logged { background: #2dd4bf; }
    .fd-meal-dot.missed { background: #2a2a3e; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Hearth Dash</h1>
      <nav>
        <a href="#dashboard" class="active" data-tab="dashboard">Dashboard</a>
        <a href="#moods" data-tab="moods">Moods</a>
        <a href="#notes" data-tab="notes">Notes</a>
        <a href="#moments" data-tab="moments">Moments</a>
        <a href="#dates" data-tab="dates">Dates</a>
        <a href="#shopping" data-tab="shopping">Shopping</a>
        <a href="#pressure" data-tab="pressure">Pressure</a>
        <a href="#food" data-tab="food">Food</a>
        <a href="/logout">Logout</a>
      </nav>
    </header>

    <!-- DASHBOARD TAB -->
    <div id="dashboard" class="tab-content active">
      <div class="grid">
        <div class="card"><h2>Current Moods</h2><div class="mood-display" id="mood-display"><div class="mood-person"><h3>${P1HTML}</h3><div class="mood-value" id="p1-mood">&mdash;</div><div class="mood-time" id="p1-mood-time"></div></div><div class="mood-person"><h3>${P2HTML}</h3><div class="mood-value" id="p2-mood">&mdash;</div><div class="mood-time" id="p2-mood-time"></div></div></div></div>
        <div class="card"><h2>Latest Note</h2><div id="latest-note"><p class="empty">No notes yet</p></div></div>
        <div class="card"><h2>Next Date</h2><div id="next-date"><p class="empty">No upcoming dates</p></div></div>
        <div class="card"><h2>Weather</h2><div id="weather-display"><p class="empty">Loading weather...</p></div></div>
        <div class="card"><h2>Shopping</h2><div id="shop-dashboard"><p class="empty">Loading...</p></div></div>
        <div class="card"><h2>Food Diary</h2><div id="food-dashboard"><p class="empty">Loading...</p></div></div>
      </div>
    </div>

    <!-- MOODS TAB -->
    <div id="moods" class="tab-content">
      <div class="grid">
        <div class="card"><h2>Log Mood</h2><form id="mood-form"><select name="partner" required style="margin-bottom:0.5rem"><option value="">Who are you?</option><option value="${P1HTML}">${P1HTML}</option><option value="${P2HTML}">${P2HTML}</option></select><select name="mood" required style="margin-bottom:0.5rem"><option value="">How are you feeling?</option><option value="great">&#128522; Great</option><option value="good">&#128578; Good</option><option value="okay">&#128528; Okay</option><option value="tired">&#128564; Tired</option><option value="stressed">&#128560; Stressed</option><option value="low">&#128532; Low</option></select><textarea name="note" placeholder="Any notes? (optional)" style="margin-bottom:0.5rem"></textarea><button type="submit" class="btn">Log Mood</button></form></div>
        <div class="card"><h2>Recent Moods</h2><div id="mood-history"><p class="empty">No mood entries yet</p></div></div>
      </div>
    </div>

    <!-- NOTES TAB -->
    <div id="notes" class="tab-content">
      <div class="grid">
        <div class="card"><h2>Leave a Note</h2><form id="note-form"><select name="from" required style="margin-bottom:0.5rem"><option value="">From</option><option value="${P1HTML}">${P1HTML}</option><option value="${P2HTML}">${P2HTML}</option></select><textarea name="content" placeholder="Your note..." required style="margin-bottom:0.5rem"></textarea><button type="submit" class="btn">Post Note</button></form></div>
        <div class="card" style="grid-column:span 2"><h2>Fridge Notes</h2><div id="notes-display"><p class="empty">No notes on the fridge</p></div></div>
      </div>
    </div>

    <!-- MOMENTS TAB -->
    <div id="moments" class="tab-content">
      <div class="grid">
        <div class="card"><h2>Add Moment</h2><form id="moment-form"><input type="date" name="date" required style="margin-bottom:0.5rem"><input type="text" name="title" placeholder="What happened?" required style="margin-bottom:0.5rem"><textarea name="description" placeholder="Tell me more..." style="margin-bottom:0.5rem"></textarea><button type="submit" class="btn">Save Moment</button></form></div>
        <div class="card" style="grid-column:span 2"><h2>Timeline</h2><div id="moments-timeline"><p class="empty">No moments recorded yet</p></div></div>
      </div>
    </div>

    <!-- DATES TAB -->
    <div id="dates" class="tab-content">
      <div class="grid">
        <div class="card">
          <h2>Add Date</h2>
          <form id="date-form">
            <input type="date" name="date" required style="margin-bottom:0.5rem">
            <input type="text" name="title" placeholder="What's the occasion?" required style="margin-bottom:0.5rem">
            <label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;font-size:0.85rem;color:#71717a"><input type="checkbox" name="recurring"> Recurring yearly</label>
            <button type="submit" class="btn">Save Date</button>
          </form>
        </div>
        <div class="card" style="grid-column:span 2">
          <h2>Important Dates</h2>
          <div id="dates-list"><p class="empty">No dates saved yet</p></div>
        </div>
      </div>
    </div>

    <!-- SHOPPING TAB -->
    <div id="shopping" class="tab-content">
      <div class="grid">
        <div class="card">
          <h2>Add Item</h2>
          <form id="shop-form">
            <input type="text" name="item" placeholder="What do you need?" required style="margin-bottom:0.5rem">
            <select name="category" style="margin-bottom:0.5rem">
              <option value="Groceries">Groceries</option>
              <option value="Household">Household</option>
              <option value="Health">Health</option>
              <option value="Other">Other</option>
            </select>
            <select name="added_by" required style="margin-bottom:0.5rem">
              <option value="${P1HTML}">${P1HTML}</option>
              <option value="${P2HTML}">${P2HTML}</option>
            </select>
            <button type="submit" class="btn">Add</button>
          </form>
        </div>
        <div class="card" style="grid-column:span 2">
          <h2>Shopping List</h2>
          <div id="shop-list"><p class="empty">Nothing on the list</p></div>
          <div class="shop-actions">
            <button class="btn btn-ghost" id="shop-clear-checked">Clear Checked</button>
          </div>
        </div>
      </div>
    </div>

    <!-- PRESSURE TAB -->
    <div id="pressure" class="tab-content">
      <div class="grid">
        <div class="card" style="grid-column:1/-1">
          <h2>Pressure Overview</h2>
          <div class="pressure-stats">
            <div class="pressure-stat">
              <div class="pressure-stat-label">Current</div>
              <div class="pressure-stat-value" id="pr-current">&ndash;</div>
            </div>
            <div class="pressure-stat">
              <div class="pressure-stat-label">6h Change (past)</div>
              <div class="pressure-stat-value" id="pr-past-shift">&ndash;</div>
            </div>
            <div class="pressure-stat">
              <div class="pressure-stat-label">6h Change (forecast)</div>
              <div class="pressure-stat-value" id="pr-future-shift">&ndash;</div>
            </div>
          </div>
        </div>
        <div class="card" style="grid-column:1/-1">
          <h2>Pressure Trend</h2>
          <canvas class="pressure-canvas" id="pressure-chart"></canvas>
          <div class="pressure-legend">
            <span class="leg-hist">History</span>
            <span class="leg-forecast">Forecast</span>
            <span class="leg-now">Now</span>
            <span class="leg-watch">Watch</span>
            <span class="leg-warn">Warning</span>
            <span class="leg-crit">Critical</span>
          </div>
        </div>
      </div>
    </div>

    <!-- FOOD DIARY TAB -->
    <div id="food" class="tab-content">
      <div class="fd-grid">
        <section>
          <div class="card" style="margin-bottom:1rem;">
            <h2>Log Meal</h2>
            <form id="food-form">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.5rem;">
                <select id="fd-meal-type" name="meal_type" required>
                  <option value="">Meal type</option>
                  <option value="breakfast">Breakfast</option>
                  <option value="lunch">Lunch</option>
                  <option value="dinner">Dinner</option>
                  <option value="snack">Snack</option>
                </select>
                <input type="time" id="fd-time" name="time">
              </div>
              <textarea name="note" id="fd-note" placeholder="What did you eat?" style="margin-bottom:0.5rem"></textarea>
              <div class="fd-upload-area" id="fd-upload-area">
                <span id="fd-upload-text">Tap to add photo (optional)</span>
                <input type="file" id="fd-photo" accept="image/*" style="display:none">
              </div>
              <img id="fd-preview" class="fd-photo-preview" alt="Preview">
              <button type="submit" class="btn" style="margin-top:0.5rem">Log Meal</button>
            </form>
          </div>
          <div class="card">
            <h2>Water</h2>
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5rem;">
              <span class="fd-water-total" id="fd-water-total">0 ml</span>
              <span class="fd-water-target">/ 2000 ml</span>
            </div>
            <div class="fd-water-bar">
              <div class="fd-water-fill" id="fd-water-fill" style="width:0%"></div>
              <div class="fd-water-label" id="fd-water-pct">0%</div>
            </div>
            <div class="fd-water-btns">
              <button class="fd-water-btn" data-ml="250">Glass (250ml)</button>
              <button class="fd-water-btn" data-ml="500">Bottle (500ml)</button>
              <button class="fd-water-btn" data-ml="150">Small (150ml)</button>
              <button class="fd-water-btn" data-ml="750">Large (750ml)</button>
            </div>
          </div>
        </section>
        <section>
          <div id="fd-review-area"></div>
          <div class="fd-patterns" id="fd-patterns">
            <div class="fd-pattern"><div class="fd-pattern-label">Today's Meals</div><div class="fd-pattern-value" id="fd-today-count">0</div></div>
            <div class="fd-pattern"><div class="fd-pattern-label">Water</div><div class="fd-pattern-value" id="fd-today-water" style="color:#2dd4bf">0 ml</div></div>
            <div class="fd-pattern"><div class="fd-pattern-label">This Week</div><div class="fd-pattern-value" id="fd-week-avg">--</div></div>
          </div>
          <div class="card" style="margin-bottom:1rem;">
            <h2>Today's Meals</h2>
            <div id="fd-today-meals"><p class="empty">Nothing logged yet today</p></div>
          </div>
          <div class="card" style="margin-bottom:1rem;">
            <h2>This Week</h2>
            <div id="fd-week-view"><p class="empty">Log meals to see weekly patterns</p></div>
          </div>
          <div class="card">
            <h2>Past Reviews</h2>
            <div id="fd-past-reviews"><p class="empty">No reviews yet</p></div>
          </div>
        </section>
      </div>
      <div class="fd-overlay" id="fd-overlay"></div>
    </div>
  </div>

  <script>
    const P1 = ${jsonForInlineScript(P1)};
    const P2 = ${jsonForInlineScript(P2)};

    /* === Tab Navigation === */
    document.querySelectorAll('nav a[data-tab]').forEach(link=>{link.addEventListener('click',e=>{e.preventDefault();const tab=e.target.dataset.tab;document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));document.querySelectorAll('nav a[data-tab]').forEach(l=>l.classList.remove('active'));document.getElementById(tab).classList.add('active');e.target.classList.add('active');window.location.hash=tab;if(tab==='pressure'&&_pressureGraphData)setTimeout(()=>drawPressureChart(_pressureGraphData),50)})});
    if(window.location.hash){const tab=window.location.hash.substring(1);const tabEl=document.getElementById(tab);const linkEl=document.querySelector('nav a[data-tab="'+tab+'"]');if(tabEl&&linkEl){document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));document.querySelectorAll('nav a[data-tab]').forEach(l=>l.classList.remove('active'));tabEl.classList.add('active');linkEl.classList.add('active');if(tab==='pressure')setTimeout(()=>{if(_pressureGraphData)drawPressureChart(_pressureGraphData)},500)}}

    /* === API Helper === */
    async function api(endpoint,method='GET',data=null){const opts={method,headers:{'Content-Type':'application/json'}};if(data)opts.body=JSON.stringify(data);const res=await fetch('/api'+endpoint,opts);return res.json()}
    function moodEmoji(m){return{great:'\\u{1F60A}',good:'\\u{1F642}',okay:'\\u{1F610}',tired:'\\u{1F634}',stressed:'\\u{1F630}',low:'\\u{1F614}'}[m]||'\\u2753'}
    function timeAgo(d){const s=Math.floor((new Date()-new Date(d+'Z'))/1000);if(s<60)return'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';if(s<604800)return Math.floor(s/86400)+'d ago';return new Date(d).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}
    function sanitize(s=''){return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}

    /* === Dashboard === */
    async function loadDashboard(){try{const data=await api('/dashboard');
      if(data.moods){
        if(data.moods[P1]){document.getElementById('p1-mood').textContent=moodEmoji(data.moods[P1].mood);document.getElementById('p1-mood-time').textContent=timeAgo(data.moods[P1].created_at)}
        if(data.moods[P2]){document.getElementById('p2-mood').textContent=moodEmoji(data.moods[P2].mood);document.getElementById('p2-mood-time').textContent=timeAgo(data.moods[P2].created_at)}
      }
      if(data.latestNote){document.getElementById('latest-note').innerHTML='<div class="note-card">"'+sanitize(data.latestNote.content)+'"<div class="note-meta">\\u2014 '+sanitize(data.latestNote.from_partner)+', '+timeAgo(data.latestNote.created_at)+'</div></div>'}
      if(data.nextDate){const daysUntil=Math.ceil((new Date(data.nextDate.date)-new Date())/(1000*60*60*24));document.getElementById('next-date').innerHTML='<div class="countdown">'+daysUntil+'</div><div class="countdown-label">days until '+sanitize(data.nextDate.title)+'</div>'}
      if(data.shoppingCount!==undefined){const sel=document.getElementById('shop-dashboard');sel.innerHTML=data.shoppingCount>0?'<div class="shop-count">'+data.shoppingCount+'</div><div style="color:#71717a;font-size:0.85rem">items to get</div>':'<p class="empty">List is clear</p>'}
      if(data.todayMeals!==undefined){const fdEl=document.getElementById('food-dashboard');const mc=data.todayMeals.length;const wm=data.waterTotal||0;const mt=data.todayMeals.map(m=>m.meal_type);const hB=mt.includes('breakfast'),hL=mt.includes('lunch'),hD=mt.includes('dinner');let fh='<div style="display:flex;gap:1.5rem;align-items:center"><div><div class="shop-count">'+mc+'</div><div style="color:#71717a;font-size:0.75rem">meals today</div></div><div><div style="font-size:0.8rem">'+(hB?'\\u2705':'\\u2B1C')+' Breakfast '+(hL?'\\u2705':'\\u2B1C')+' Lunch '+(hD?'\\u2705':'\\u2B1C')+' Dinner</div><div style="font-size:0.8rem;color:#2dd4bf;margin-top:0.25rem">\\u{1F4A7} '+wm+' / 2000 ml</div></div></div>';fdEl.innerHTML=fh}
    }catch(err){console.error(err)}}

    /* === Tab Loaders === */
    async function loadMoods(){try{const data=await api('/moods');const c=document.getElementById('mood-history');if(data.moods&&data.moods.length>0){c.innerHTML=data.moods.map(m=>'<div class="moment-item"><strong>'+sanitize(m.partner)+'</strong>: '+moodEmoji(m.mood)+' '+sanitize(m.mood)+(m.note?'<br><small style="color:#71717a">'+sanitize(m.note)+'</small>':'')+'<div class="moment-date">'+timeAgo(m.created_at)+'</div></div>').join('')}}catch(err){console.error(err)}}
    async function loadNotes(){try{const data=await api('/notes');const c=document.getElementById('notes-display');if(data.notes&&data.notes.length>0){c.innerHTML=data.notes.map(n=>'<div class="note-card">"'+sanitize(n.content)+'"<div class="note-meta">\\u2014 '+sanitize(n.from_partner)+', '+timeAgo(n.created_at)+'</div></div>').join('')}}catch(err){console.error(err)}}
    async function loadMoments(){try{const data=await api('/moments');const c=document.getElementById('moments-timeline');if(data.moments&&data.moments.length>0){c.innerHTML=data.moments.map(m=>'<div class="moment-item"><strong>'+sanitize(m.title)+'</strong>'+(m.description?'<br><small style="color:#71717a">'+sanitize(m.description)+'</small>':'')+'<div class="moment-date">'+new Date(m.date).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})+'</div></div>').join('')}}catch(err){console.error(err)}}

    /* === Form Handlers === */
    document.getElementById('mood-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);await api('/moods','POST',{partner:f.get('partner'),mood:f.get('mood'),note:f.get('note')});e.target.reset();loadMoods();loadDashboard()});
    document.getElementById('note-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);await api('/notes','POST',{from:f.get('from'),content:f.get('content')});e.target.reset();loadNotes();loadDashboard()});
    document.getElementById('moment-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);await api('/moments','POST',{date:f.get('date'),title:f.get('title'),description:f.get('description')});e.target.reset();loadMoments()});

    /* === Dates === */
    async function loadDates(){try{const data=await api('/dates');const el=document.getElementById('dates-list');if(!data.dates||!data.dates.length){el.innerHTML='<p class="empty">No dates saved yet</p>';return;}const now=new Date();now.setHours(0,0,0,0);el.innerHTML=data.dates.map(d=>{const dt=new Date(d.date+'T00:00:00');const diff=Math.ceil((dt-now)/(1000*60*60*24));let countdown='';if(diff===0)countdown='<span style="color:#2dd4bf;font-weight:600">Today!</span>';else if(diff===1)countdown='<span style="color:#2dd4bf">Tomorrow</span>';else if(diff>0)countdown='<span style="color:#71717a">in '+diff+' days</span>';else countdown='<span style="color:#52525b">'+Math.abs(diff)+' days ago</span>';return'<div class="moment-item" style="display:flex;justify-content:space-between;align-items:center"><div><strong>'+sanitize(d.title)+'</strong>'+(d.recurring?' <span style="font-size:0.7rem;color:#c084fc">\\u{1F501} yearly</span>':'')+'<div class="moment-date">'+dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+' \\u00B7 '+countdown+'</div></div><button class="shop-del" data-del="'+d.id+'">\\u2715</button></div>'}).join('');el.querySelectorAll('.shop-del').forEach(b=>b.onclick=async()=>{await api('/dates/'+b.dataset.del,'DELETE');loadDates()})}catch(err){console.error(err)}}
    document.getElementById('date-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);await api('/dates','POST',{date:f.get('date'),title:f.get('title'),recurring:f.get('recurring')==='on'});e.target.reset();loadDates();loadDashboard()});

    /* === Weather === */
    async function loadWeather(){try{const data=await fetch('/api/weather').then(r=>r.json());const el=document.getElementById('weather-display');if(data.error){el.innerHTML='<p class="empty">'+sanitize(data.error)+'</p>';return}let shiftHtml='';if(data.shift_alert&&data.shift_alert!=='none'){const arrow=data.pressure_trend==='falling'?'\\u2198':data.pressure_trend==='rising'?'\\u2197':'\\u2192';const s6=Math.abs(data.shift_6h_future||0);const s24=Math.abs(data.shift_24h_future||0);const use24h=s24>s6*2;const shiftVal=use24h?s24.toFixed(0):s6.toFixed(1);const window_=use24h?'24h':'6h';const dir=(data.shift_6h_future||0)<0||(data.shift_24h_future||0)<0?'dropping':'rising';shiftHtml='<div class="shift-alert '+data.shift_alert+'"><span class="shift-arrow">'+arrow+'</span><span>Pressure '+dir+' ~'+shiftVal+' hPa over next '+window_+'</span></div>'}el.innerHTML='<div class="weather-main"><img src="https://openweathermap.org/img/wn/'+data.icon+'@2x.png" width="50" height="50" alt="'+sanitize(data.description)+'" style="filter:brightness(1.2)"><div><div class="weather-temp">'+data.temp+'\\u00B0C</div><div class="weather-desc">'+sanitize(data.description)+'</div></div></div><div class="weather-details"><span><span class="label">Feels like</span> '+data.feels_like+'\\u00B0C</span><span><span class="label">Humidity</span> '+data.humidity+'%</span><span><span class="label">Pressure</span> '+data.pressure+' hPa</span><span><span class="label">Wind</span> '+data.wind+' mph</span></div><div class="migraine-alert '+data.migraine_risk+'">'+(data.migraine_risk==='low'?'\\u{1F7E2}':data.migraine_risk==='moderate'?'\\u{1F7E1}':'\\u{1F534}')+' '+sanitize(data.migraine_note)+'</div>'+shiftHtml+'<div style="font-size:0.65rem;color:#52525b;margin-top:0.5rem">'+sanitize(data.location)+' \\u00B7 Updated '+timeAgo(data.updated)+'</div>'}catch(err){document.getElementById('weather-display').innerHTML='<p class="empty">Could not load weather</p>';console.error(err)}}

    /* === Pressure Chart === */
    let _pressureGraphData=null;
    const $=id=>document.getElementById(id);
    async function loadPressure(){try{const[weatherData,pressureData]=await Promise.all([fetch('/api/weather').then(r=>r.json()),fetch('/api/pressure').then(r=>r.json())]);if(weatherData.pressure)$('pr-current').textContent=weatherData.pressure+' hPa';if(weatherData.shift_6h_past!==undefined){const v=weatherData.shift_6h_past;const el=$('pr-past-shift');el.textContent=(v>0?'+':'')+v.toFixed(1)+' hPa';el.style.color=Math.abs(v)>=8?'#fca5a5':Math.abs(v)>=4?'#facc15':'#5eead4'}if(weatherData.shift_6h_future!==undefined){const v=weatherData.shift_6h_future;const el=$('pr-future-shift');el.textContent=(v>0?'+':'')+v.toFixed(1)+' hPa';el.style.color=Math.abs(v)>=8?'#fca5a5':Math.abs(v)>=4?'#facc15':'#5eead4'}if(pressureData&&!pressureData.error){_pressureGraphData=pressureData;if(document.getElementById('pressure').classList.contains('active'))drawPressureChart(pressureData)}}catch(err){console.error('Pressure load error:',err)}}

    function drawPressureChart(data){const c=$('pressure-chart');const ctx=c.getContext('2d');const dpr=window.devicePixelRatio||1;const W=c.width=c.clientWidth*dpr;const H=c.height=280*dpr;ctx.clearRect(0,0,W,H);const history=data.history||[];const forecast=data.forecast||[];if(!history.length&&!forecast.length){ctx.fillStyle='#71717a';ctx.font=(12*dpr)+'px system-ui';ctx.fillText('No pressure data yet',20*dpr,30*dpr);return}const allPoints=[];history.forEach(h=>allPoints.push({ts:new Date(h.recorded_at+'Z').getTime(),pressure:h.pressure_hpa,type:'history'}));if(data.current)allPoints.push({ts:new Date(data.current.timestamp+'Z').getTime(),pressure:data.current.pressure,type:'current'});forecast.forEach(f=>allPoints.push({ts:new Date(f.dt_txt+'Z').getTime(),pressure:f.pressure,type:'forecast'}));if(!allPoints.length)return;allPoints.sort((a,b)=>a.ts-b.ts);const nowMs=Date.now();const windowStart=nowMs-12*60*60*1000;const windowEnd=nowMs+36*60*60*1000;const visible=allPoints.filter(p=>p.ts>=windowStart&&p.ts<=windowEnd);if(!visible.length)visible.push(...allPoints);const minT=visible[0].ts;const maxT=visible[visible.length-1].ts;const timeRange=maxT-minT||1;const pressures=visible.map(p=>p.pressure);let minP=Math.min(...pressures);let maxP=Math.max(...pressures);const pPad=Math.max(3,(maxP-minP)*0.1);minP-=pPad;maxP+=pPad;const pRange=maxP-minP||1;const pad={top:30*dpr,right:50*dpr,bottom:40*dpr,left:55*dpr};const plotW=W-pad.left-pad.right;const plotH=H-pad.top-pad.bottom;const toX=ts=>pad.left+((ts-minT)/timeRange)*plotW;const toY=p=>pad.top+plotH-((p-minP)/pRange)*plotH;ctx.strokeStyle='rgba(255,255,255,0.06)';ctx.lineWidth=dpr;const pStep=pRange>20?5:pRange>10?2:1;for(let p=Math.ceil(minP/pStep)*pStep;p<=maxP;p+=pStep){const y=toY(p);ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(W-pad.right,y);ctx.stroke();ctx.fillStyle='#52525b';ctx.font=(10*dpr)+'px system-ui';ctx.textAlign='right';ctx.fillText(p.toFixed(0)+' hPa',pad.left-6*dpr,y+4*dpr)}ctx.textAlign='center';ctx.fillStyle='#52525b';ctx.font=(9*dpr)+'px system-ui';const totalHours=timeRange/(1000*60*60);const labelStep=totalHours>96?24:totalHours>48?12:6;const firstHour=new Date(minT);firstHour.setMinutes(0,0,0);firstHour.setHours(Math.ceil(firstHour.getHours()/labelStep)*labelStep);for(let t=firstHour.getTime();t<=maxT;t+=labelStep*60*60*1000){const x=toX(t);const d=new Date(t);ctx.fillText(d.getUTCDate()+'/'+(d.getUTCMonth()+1)+' '+d.getUTCHours()+':00',x,H-pad.bottom+16*dpr)}const nowTs=Date.now();if(nowTs>=minT&&nowTs<=maxT){const nx=toX(nowTs);ctx.strokeStyle='rgba(192,132,252,0.5)';ctx.lineWidth=2*dpr;ctx.setLineDash([4*dpr,4*dpr]);ctx.beginPath();ctx.moveTo(nx,pad.top);ctx.lineTo(nx,H-pad.bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#c084fc';ctx.font=(10*dpr)+'px system-ui';ctx.textAlign='center';ctx.fillText('Now',nx,pad.top-6*dpr)}const SIX_H=6*60*60*1000;for(let i=0;i<visible.length;i++){let j=i+1;while(j<visible.length&&(visible[j].ts-visible[i].ts)<SIX_H)j++;if(j>=visible.length)continue;const delta=Math.abs(visible[j].pressure-visible[i].pressure);let color=null;if(delta>=12)color='rgba(239,68,68,0.12)';else if(delta>=8)color='rgba(192,132,252,0.10)';else if(delta>=4)color='rgba(234,179,8,0.08)';if(color){ctx.fillStyle=color;ctx.fillRect(toX(visible[i].ts),pad.top,toX(visible[j].ts)-toX(visible[i].ts),plotH)}}const histPts=visible.filter(p=>p.type==='history'||p.type==='current');if(histPts.length>1){ctx.strokeStyle='#2dd4bf';ctx.lineWidth=2.5*dpr;ctx.beginPath();histPts.forEach((p,i)=>{const x=toX(p.ts),y=toY(p.pressure);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke()}const fcPts=visible.filter(p=>p.type==='forecast');const bridgePoint=histPts.length?histPts[histPts.length-1]:null;if(fcPts.length>0){ctx.strokeStyle='rgba(45,212,191,0.45)';ctx.lineWidth=2*dpr;ctx.setLineDash([6*dpr,4*dpr]);ctx.beginPath();if(bridgePoint)ctx.moveTo(toX(bridgePoint.ts),toY(bridgePoint.pressure));fcPts.forEach((p,i)=>{const x=toX(p.ts),y=toY(p.pressure);if(!bridgePoint&&i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke();ctx.setLineDash([])}ctx.strokeStyle='rgba(255,255,255,.15)';ctx.lineWidth=dpr;ctx.beginPath();ctx.moveTo(pad.left,pad.top);ctx.lineTo(pad.left,H-pad.bottom);ctx.lineTo(W-pad.right,H-pad.bottom);ctx.stroke()}

    /* === Shopping === */
    async function loadShopping(){try{const data=await api('/shopping');const el=document.getElementById('shop-list');if(!data.items||!data.items.length){el.innerHTML='<p class="empty">Nothing on the list</p>';return}const groups={};data.items.forEach(i=>{if(!groups[i.category])groups[i.category]=[];groups[i.category].push(i)});let html='';for(const[cat,items]of Object.entries(groups)){html+='<div class="shop-category">'+sanitize(cat)+'</div>';items.forEach(i=>{html+='<div class="shop-item'+(i.checked?' checked':'')+'"><input type="checkbox" class="shop-check" data-id="'+i.id+'"'+(i.checked?' checked':'')+'><span class="shop-text">'+sanitize(i.item)+'</span><span class="shop-by">'+sanitize(i.added_by)+'</span><button class="shop-del" data-del="'+i.id+'">\\u2715</button></div>'})}el.innerHTML=html;el.querySelectorAll('.shop-check').forEach(c=>c.onchange=async()=>{await api('/shopping/'+c.dataset.id+'/check','POST');loadShopping();loadDashboard()});el.querySelectorAll('.shop-del').forEach(b=>b.onclick=async()=>{await api('/shopping/'+b.dataset.del,'DELETE');loadShopping();loadDashboard()})}catch(err){console.error(err)}}
    document.getElementById('shop-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);await api('/shopping','POST',{item:f.get('item'),category:f.get('category'),added_by:f.get('added_by')});e.target.reset();loadShopping();loadDashboard()});
    document.getElementById('shop-clear-checked').addEventListener('click',async()=>{await api('/shopping/checked','DELETE');loadShopping()});

    /* === Food Diary === */
    let fdPhotoFile=null;
    document.getElementById('fd-upload-area').addEventListener('click',()=>document.getElementById('fd-photo').click());
    document.getElementById('fd-photo').addEventListener('change',e=>{const file=e.target.files[0];if(!file)return;fdPhotoFile=file;document.getElementById('fd-upload-area').classList.add('has-file');document.getElementById('fd-upload-text').textContent=file.name;const reader=new FileReader();reader.onload=ev=>{const preview=document.getElementById('fd-preview');preview.src=ev.target.result;preview.style.display='block'};reader.readAsDataURL(file)});
    document.getElementById('food-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);let photoKey=null;if(fdPhotoFile){const fd=new FormData();fd.append('photo',fdPhotoFile);const uploadRes=await fetch('/api/food/photo',{method:'POST',body:fd});const uploadData=await uploadRes.json();if(uploadData.key)photoKey=uploadData.key}await api('/food','POST',{meal_type:f.get('meal_type'),time:f.get('time'),note:f.get('note'),photo_key:photoKey});e.target.reset();fdPhotoFile=null;document.getElementById('fd-upload-area').classList.remove('has-file');document.getElementById('fd-upload-text').textContent='Tap to add photo (optional)';document.getElementById('fd-preview').style.display='none';loadFood()});

    async function loadFood(){try{const[todayData,waterData,reviewData,histData]=await Promise.all([api('/food'),api('/water'),api('/food/reviews?date='+new Date().toISOString().slice(0,10)),api('/food/history')]);const meals=todayData.entries||[];const todayEl=document.getElementById('fd-today-meals');if(meals.length){todayEl.innerHTML=meals.map(m=>'<div class="fd-meal-card">'+(m.photo_key?'<img src="/api/food/photo/'+encodeURIComponent(m.photo_key)+'" alt="meal" onclick="toggleFdPhoto(this)">':'')+'<div class="fd-meal-info"><div class="fd-meal-type">'+sanitize(m.meal_type)+'</div><div class="fd-meal-time">'+m.time+'</div>'+(m.note?'<div class="fd-meal-note">'+sanitize(m.note)+'</div>':'')+'</div></div>').join('')}else{todayEl.innerHTML='<p class="empty">Nothing logged yet today</p>'}document.getElementById('fd-today-count').textContent=meals.length;const waterTotal=waterData.total_ml||0;document.getElementById('fd-water-total').textContent=waterTotal+' ml';document.getElementById('fd-today-water').textContent=waterTotal+' ml';const pct=Math.min(100,Math.round((waterTotal/2000)*100));document.getElementById('fd-water-fill').style.width=pct+'%';document.getElementById('fd-water-pct').textContent=pct+'%';const reviewEl=document.getElementById('fd-review-area');if(reviewData.review){reviewEl.innerHTML='<div class="fd-review-card"><div class="fd-review-header"><span class="fd-review-name">'+sanitize(reviewData.review.reviewer)+'</span><span class="fd-review-label">Daily Review</span></div><div class="fd-review-text">'+sanitize(reviewData.review.review)+'</div><div class="fd-review-date">'+reviewData.review.date+'</div></div>'}else{reviewEl.innerHTML='<div class="fd-review-card empty-review"><div class="fd-review-text">No review yet for today</div></div>'}const histEntries=histData.entries||[];const weekEl=document.getElementById('fd-week-view');const dayMap={};histEntries.forEach(m=>{if(!dayMap[m.date])dayMap[m.date]=[];dayMap[m.date].push(m)});const days=Object.keys(dayMap).sort().reverse().slice(0,7);if(days.length){weekEl.innerHTML=days.map(d=>{const ms=dayMap[d];const types=ms.map(m=>m.meal_type);return'<div class="fd-week-day"><span style="width:60px;color:#71717a">'+new Date(d+'T00:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric'})+'</span><span class="fd-meal-dot '+(types.includes('breakfast')?'logged':'missed')+'" title="Breakfast"></span><span class="fd-meal-dot '+(types.includes('lunch')?'logged':'missed')+'" title="Lunch"></span><span class="fd-meal-dot '+(types.includes('dinner')?'logged':'missed')+'" title="Dinner"></span><span style="color:#71717a;font-size:0.7rem">'+ms.length+' meals</span></div>'}).join('')}else{weekEl.innerHTML='<p class="empty">Log meals to see weekly patterns</p>'}const reviewsData=await api('/food/reviews');const pastEl=document.getElementById('fd-past-reviews');if(reviewsData.reviews&&reviewsData.reviews.length){pastEl.innerHTML=reviewsData.reviews.map(r=>'<div class="fd-review-card"><div class="fd-review-header"><span class="fd-review-name">'+sanitize(r.reviewer)+'</span><span class="fd-review-label">'+r.date+'</span></div><div class="fd-review-text">'+sanitize(r.review)+'</div></div>').join('')}const weekAvg=days.length?Math.round(histEntries.length/days.length*10)/10:'--';document.getElementById('fd-week-avg').textContent=weekAvg+' meals/day'}catch(err){console.error(err)}}

    document.querySelectorAll('.fd-water-btn').forEach(b=>b.addEventListener('click',async()=>{const ml=parseInt(b.dataset.ml);await api('/water','POST',{amount_ml:ml});loadFood()}));

    function toggleFdPhoto(img){if(img.classList.contains('fd-expanded')){img.classList.remove('fd-expanded');document.getElementById('fd-overlay').style.display='none'}else{img.classList.add('fd-expanded');document.getElementById('fd-overlay').style.display='block';document.getElementById('fd-overlay').onclick=()=>{img.classList.remove('fd-expanded');document.getElementById('fd-overlay').style.display='none'}}}

    /* === Init === */
    loadDashboard();loadMoods();loadNotes();loadMoments();loadDates();loadWeather();loadPressure();loadShopping();loadFood();
  </script>
</body>
</html>`;
}

/* ========================= BACKEND ========================= */

export const applicationHandler = {
  async fetch(request, env, ctx) {
    const config = getConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // MCP endpoint
    if (!config.PASSWORD || !config.SESSION_SECRET) {
      return new Response('Hearth Dash is not configured. Set DASHBOARD_PASSWORD and SESSION_SECRET as Cloudflare Worker secrets.', {
        status: 503,
        headers: securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }),
      });
    }

    // Auth
    const sessionToken = getCookie(request, '__Host-hearth_session');
    const isAuthenticated = await verifySession(sessionToken, config.SESSION_SECRET);

    if (path === '/login') {
      if (request.method === 'POST') {
        if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
        if (Number(request.headers.get('Content-Length') || 0) > 16 * 1024) return new Response('Request body is too large', { status: 413 });
        if (!(await withinRateLimit(env, request, 'login', 10, 600))) {
          return new Response('Too many login attempts. Try again later.', { status: 429, headers: securityHeaders({ 'Retry-After': '600' }) });
        }
        const formData = await request.formData();
        if (await safeEqual(formData.get('password'), config.PASSWORD)) {
          const session = await createSession(config.SESSION_SECRET);
          return new Response(null, { status: 302, headers: securityHeaders({ 'Location': '/', 'Set-Cookie': sessionCookie(session), 'Cache-Control': 'no-store' }) });
        }
        return new Response(getLoginPage(config).replace('{{ERROR}}', '<p class="error">Wrong password</p>'), { status: 401, headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }) });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: securityHeaders({ 'Allow': 'GET, POST' }) });
      return new Response(getLoginPage(config).replace('{{ERROR}}', ''), { headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }) });
    }
    if (path === '/logout') return new Response(null, { status: 302, headers: securityHeaders({ 'Location': '/login', 'Set-Cookie': sessionCookie('', 0), 'Cache-Control': 'no-store' }) });
    if (!isAuthenticated) return Response.redirect(url.origin + '/login', 302);

    if (!['GET', 'HEAD'].includes(request.method) && !sameOrigin(request)) {
      return new Response('Forbidden', { status: 403 });
    }

    // API routes
    if (path === '/api/weather') return handleWeather(env);
    if (path === '/api/pressure') return handlePressure(env);
    if (path === '/api/food/photo' && request.method === 'POST') return handleFoodPhotoUpload(request, env);
    if (path.startsWith('/api/food/photo/') && request.method === 'GET') {
      const key = decodeURIComponent(path.substring('/api/food/photo/'.length));
      return handleFoodPhotoServe(key, env);
    }
    if (path.startsWith('/api/')) return handleAPI(request, env, path.substring(4), config);

    return new Response(getDashboardHTML(config), { headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }) });
  }
};

const OAUTH_SCOPES = ['hearth:read', 'hearth:write'];
const OAUTH_CSRF_COOKIE = '__Host-hearth_oauth_csrf';

export const oauthApiHandler = {
  async fetch(request, env, ctx) {
    const config = getConfig(env);
    const remainder = new URL(request.url).pathname.substring('/mcp'.length);
    const bearer = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearer ? await env.OAUTH_PROVIDER.unwrapToken(bearer) : null;
    const scopes = Array.isArray(token?.scope) ? token.scope : [];
    return handleMCP(request, env, config, remainder, scopes);
  },
};

export const oauthDefaultHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/authorize') return applicationHandler.fetch(request, env, ctx);

    const config = getConfig(env);
    if (!config.PASSWORD || !config.SESSION_SECRET) {
      return new Response('Hearth Dash is not configured.', { status: 503, headers: securityHeaders() });
    }
    if (!['GET', 'POST'].includes(request.method)) {
      return new Response(null, { status: 405, headers: securityHeaders({ Allow: 'GET, POST' }) });
    }

    let oauthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      return renderOAuthAuthorizationError(error);
    }
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return new Response('Unknown OAuth client', { status: 400, headers: securityHeaders() });

    const sessionToken = getCookie(request, '__Host-hearth_session');
    const signedIn = await verifySession(sessionToken, config.SESSION_SECRET);

    if (request.method === 'GET') {
      const csrf = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const headers = new Headers(securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }));
      headers.append('Set-Cookie', `${OAUTH_CSRF_COOKIE}=${csrf}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      return new Response(renderOAuthConsentPage(request.url, oauthRequest, client, csrf, signedIn), { headers });
    }

    if (!sameOrigin(request)) return new Response('Forbidden', { status: 403, headers: securityHeaders() });
    if (Number(request.headers.get('Content-Length') || 0) > 16 * 1024) return new Response('Request body is too large', { status: 413 });
    if (!(await withinRateLimit(env, request, 'oauth-consent', 10, 600))) {
      return new Response('Too many authorization attempts. Try again later.', { status: 429, headers: securityHeaders({ 'Retry-After': '600' }) });
    }

    const form = await request.formData();
    const csrfCookie = getCookie(request, OAUTH_CSRF_COOKIE);
    if (!csrfCookie || !(await safeEqual(csrfCookie, form.get('csrf_token')))) {
      return new Response('Authorization form expired. Start the connection again.', { status: 400, headers: securityHeaders() });
    }
    if (form.get('decision') === 'deny') return redirectOAuthDenial(oauthRequest);

    let authenticated = signedIn;
    let newSession = null;
    if (!authenticated) {
      authenticated = await safeEqual(form.get('password'), config.PASSWORD);
      if (authenticated) newSession = await createSession(config.SESSION_SECRET);
    }
    if (!authenticated) {
      const csrf = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const headers = new Headers(securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }));
      headers.append('Set-Cookie', `${OAUTH_CSRF_COOKIE}=${csrf}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      return new Response(renderOAuthConsentPage(request.url, oauthRequest, client, csrf, false, 'Wrong dashboard password'), { status: 401, headers });
    }

    const requestedScopes = oauthRequest.scope?.length ? oauthRequest.scope : ['hearth:read'];
    const grantedScopes = requestedScopes.filter(scope => OAUTH_SCOPES.includes(scope));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: 'hearth-owner',
      metadata: { clientName: client.clientName || 'MCP client' },
      scope: grantedScopes,
      props: { userId: 'hearth-owner', scopes: grantedScopes },
    });

    const headers = new Headers(securityHeaders({ Location: redirectTo, 'Cache-Control': 'no-store' }));
    headers.append('Set-Cookie', `${OAUTH_CSRF_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    if (newSession) headers.append('Set-Cookie', sessionCookie(newSession));
    return new Response(null, { status: 302, headers });
  },
};

function renderOAuthAuthorizationError(error) {
  if (!error || typeof error.code !== 'string') return new Response('Invalid authorization request', { status: 400, headers: securityHeaders() });
  if (!error.redirectUri) return new Response(error.description || 'Invalid authorization request', { status: 400, headers: securityHeaders() });
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  redirect.searchParams.set('error_description', error.description || 'Authorization failed');
  if (error.state) redirect.searchParams.set('state', error.state);
  if (error.issuer) redirect.searchParams.set('iss', error.issuer);
  return Response.redirect(redirect, 302);
}

function redirectOAuthDenial(oauthRequest) {
  const redirect = new URL(oauthRequest.redirectUri);
  redirect.searchParams.set('error', 'access_denied');
  redirect.searchParams.set('error_description', 'The Hearth owner denied access.');
  if (oauthRequest.state) redirect.searchParams.set('state', oauthRequest.state);
  if (oauthRequest.issuer) redirect.searchParams.set('iss', oauthRequest.issuer);
  return Response.redirect(redirect, 302);
}

function renderOAuthConsentPage(action, oauthRequest, client, csrf, signedIn, error = '') {
  const clientName = escapeHtml(client.clientName || 'An MCP client');
  const redirectHost = escapeHtml(new URL(oauthRequest.redirectUri).host);
  const scopes = (oauthRequest.scope?.length ? oauthRequest.scope : ['hearth:read'])
    .filter(scope => OAUTH_SCOPES.includes(scope));
  const permissions = scopes.map(scope => scope === 'hearth:write'
    ? '<li><strong>Write:</strong> add moods, notes, moments, dates, shopping items and food reviews</li>'
    : '<li><strong>Read:</strong> view the shared Hearth dashboard data</li>').join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Hearth</title><style>
body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#fafafa;min-height:100vh;display:grid;place-items:center;margin:0}.box{background:#1a1a2e;border:1px solid #34344a;border-radius:16px;padding:2rem;max-width:520px;width:calc(100% - 3rem)}h1{margin-top:0}.muted{color:#a1a1aa}.error{color:#f87171}input{box-sizing:border-box;width:100%;padding:.9rem;background:#0f0f1a;color:#fff;border:1px solid #45455f;border-radius:8px;margin:.5rem 0 1rem}.actions{display:flex;gap:.75rem}.actions button{padding:.8rem 1rem;border-radius:8px;border:0;font-weight:650;cursor:pointer}.approve{background:#a855f7;color:white}.deny{background:#34344a;color:white}code{word-break:break-all;color:#c4b5fd}
</style></head><body><main class="box"><h1>Authorize Hearth</h1>
<p><strong>${clientName}</strong> wants access to this private dashboard.</p><ul>${permissions}</ul>
<p class="muted">After approval you will return to <code>${redirectHost}</code>. Access is token-based and expires; remove or revoke the connector to end access.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
${signedIn ? '' : '<label>Dashboard password<input type="password" name="password" autocomplete="current-password" required></label>'}
<div class="actions"><button class="approve" type="submit" name="decision" value="approve">Approve</button><button class="deny" type="submit" name="decision" value="deny">Deny</button></div>
</form></main></body></html>`;
}

export default applicationHandler;

/* ========================= REST API ========================= */

async function handleAPI(request, env, endpoint, config) {
  const method = request.method;
  try {
    /* Dashboard */
    if (endpoint === '/dashboard' && method === 'GET') {
      const [moodsP1, moodsP2, latestNote, nextDate, shoppingCount, todayMeals, todayWater] = await Promise.all([
        env.DB.prepare('SELECT * FROM moods WHERE partner = ? ORDER BY created_at DESC LIMIT 1').bind(config.PARTNER_1).first(),
        env.DB.prepare('SELECT * FROM moods WHERE partner = ? ORDER BY created_at DESC LIMIT 1').bind(config.PARTNER_2).first(),
        env.DB.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT 1').first(),
        env.DB.prepare('SELECT * FROM dates WHERE date >= date("now") ORDER BY date ASC LIMIT 1').first(),
        env.DB.prepare('SELECT COUNT(*) as cnt FROM shopping WHERE checked = 0').first(),
        env.DB.prepare("SELECT * FROM food_diary WHERE date = date('now') ORDER BY time ASC").all(),
        env.DB.prepare("SELECT SUM(amount_ml) as total FROM water_log WHERE date = date('now')").first()
      ]);
      const moods = {};
      moods[config.PARTNER_1] = moodsP1;
      moods[config.PARTNER_2] = moodsP2;
      return json({ moods, latestNote, nextDate, shoppingCount: shoppingCount ? shoppingCount.cnt : 0, todayMeals: todayMeals.results || [], waterTotal: todayWater ? todayWater.total || 0 : 0 });
    }

    /* Moods */
    if (endpoint === '/moods' && method === 'GET') { const r = await env.DB.prepare('SELECT * FROM moods ORDER BY created_at DESC LIMIT 20').all(); return json({ moods: r.results }); }
    if (endpoint === '/moods' && method === 'POST') {
      const b = await readJsonObject(request);
      const partner = requireText(b, 'partner', 80, [config.PARTNER_1, config.PARTNER_2]);
      const mood = requireText(b, 'mood', 20, ['great', 'good', 'okay', 'tired', 'stressed', 'low']);
      await env.DB.prepare('INSERT INTO moods (partner, mood, note, created_at) VALUES (?, ?, ?, datetime("now"))').bind(partner, mood, optionalText(b, 'note', 2000)).run();
      return json({ success: true });
    }

    /* Notes */
    if (endpoint === '/notes' && method === 'GET') { const r = await env.DB.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT 20').all(); return json({ notes: r.results }); }
    if (endpoint === '/notes' && method === 'POST') {
      const b = await readJsonObject(request);
      await env.DB.prepare('INSERT INTO notes (from_partner, content, created_at) VALUES (?, ?, datetime("now"))').bind(requireText(b, 'from', 80), requireText(b, 'content', 4000)).run();
      return json({ success: true });
    }

    /* Moments */
    if (endpoint === '/moments' && method === 'GET') { const r = await env.DB.prepare('SELECT * FROM moments ORDER BY date DESC').all(); return json({ moments: r.results }); }
    if (endpoint === '/moments' && method === 'POST') {
      const b = await readJsonObject(request);
      await env.DB.prepare('INSERT INTO moments (date, title, description, created_at) VALUES (?, ?, ?, datetime("now"))').bind(requireDate(b), requireText(b, 'title', 200), optionalText(b, 'description', 4000)).run();
      return json({ success: true });
    }

    /* Dates */
    if (endpoint === '/dates' && method === 'GET') { const r = await env.DB.prepare('SELECT * FROM dates ORDER BY date ASC').all(); return json({ dates: r.results }); }
    if (endpoint === '/dates' && method === 'POST') {
      const b = await readJsonObject(request);
      await env.DB.prepare('INSERT INTO dates (date, title, recurring, created_at) VALUES (?, ?, ?, datetime("now"))').bind(requireDate(b), requireText(b, 'title', 200), b.recurring === true ? 1 : 0).run();
      return json({ success: true });
    }
    const dateDelMatch = endpoint.match(/^\/dates\/(\d+)$/);
    if (dateDelMatch && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM dates WHERE id = ?').bind(+dateDelMatch[1]).run();
      return json({ success: true });
    }

    /* Shopping */
    if (endpoint === '/shopping' && method === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM shopping ORDER BY checked ASC, created_at DESC').all();
      return json({ items: r.results });
    }
    if (endpoint === '/shopping' && method === 'POST') {
      const b = await readJsonObject(request);
      const item = requireText(b, 'item', 300);
      const category = b.category ? requireText(b, 'category', 100) : 'Other';
      const addedBy = b.added_by ? requireText(b, 'added_by', 80) : config.PARTNER_1;
      await env.DB.prepare('INSERT INTO shopping (item, category, checked, added_by, created_at) VALUES (?, ?, 0, ?, datetime("now"))').bind(item, category, addedBy).run();
      return json({ success: true });
    }
    if (endpoint === '/shopping/checked' && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM shopping WHERE checked = 1').run();
      return json({ success: true });
    }
    const shopCheckMatch = endpoint.match(/^\/shopping\/(\d+)\/check$/);
    if (shopCheckMatch && method === 'POST') {
      await env.DB.prepare('UPDATE shopping SET checked = CASE WHEN checked = 0 THEN 1 ELSE 0 END WHERE id = ?').bind(+shopCheckMatch[1]).run();
      return json({ success: true });
    }
    const shopDelMatch = endpoint.match(/^\/shopping\/(\d+)$/);
    if (shopDelMatch && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM shopping WHERE id = ?').bind(+shopDelMatch[1]).run();
      return json({ success: true });
    }

    /* Food Diary */
    if (endpoint === '/food' && method === 'GET') {
      const date = new URL(request.url).searchParams.get('date');
      const r = date
        ? await env.DB.prepare('SELECT * FROM food_diary WHERE date = ? ORDER BY time ASC').bind(date).all()
        : await env.DB.prepare("SELECT * FROM food_diary WHERE date = date('now') ORDER BY time ASC").all();
      return json({ entries: r.results });
    }
    if (endpoint === '/food' && method === 'POST') {
      const b = await readJsonObject(request);
      const date = b.date ? requireDate(b) : new Date().toISOString().slice(0, 10);
      const time = b.time ? requireText(b, 'time', 5) : new Date().toISOString().slice(11, 16);
      if (!/^\d{2}:\d{2}$/.test(time)) throw Object.assign(new Error('time must use HH:MM'), { status: 400 });
      const mealType = requireText(b, 'meal_type', 20, ['breakfast', 'lunch', 'dinner', 'snack']);
      await env.DB.prepare('INSERT INTO food_diary (date, time, meal_type, note, photo_key, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))').bind(date, time, mealType, optionalText(b, 'note', 4000), optionalText(b, 'photo_key', 500)).run();
      return json({ success: true });
    }
    const foodDelMatch = endpoint.match(/^\/food\/(\d+)$/);
    if (foodDelMatch && method === 'DELETE') {
      const entry = await env.DB.prepare('SELECT photo_key FROM food_diary WHERE id = ?').bind(+foodDelMatch[1]).first();
      if (entry && entry.photo_key) { try { await env.PHOTOS.delete(entry.photo_key); } catch(e){} }
      await env.DB.prepare('DELETE FROM food_diary WHERE id = ?').bind(+foodDelMatch[1]).run();
      return json({ success: true });
    }
    if (endpoint === '/food/history' && method === 'GET') {
      const params = new URL(request.url).searchParams;
      const from = params.get('from') || new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
      const to = params.get('to') || new Date().toISOString().slice(0,10);
      const r = await env.DB.prepare('SELECT * FROM food_diary WHERE date >= ? AND date <= ? ORDER BY date DESC, time DESC').bind(from, to).all();
      return json({ entries: r.results });
    }

    /* Water Log */
    if (endpoint === '/water' && method === 'GET') {
      const date = new URL(request.url).searchParams.get('date') || null;
      const r = date
        ? await env.DB.prepare('SELECT * FROM water_log WHERE date = ? ORDER BY created_at ASC').bind(date).all()
        : await env.DB.prepare("SELECT * FROM water_log WHERE date = date('now') ORDER BY created_at ASC").all();
      const total = (r.results || []).reduce((sum, e) => sum + e.amount_ml, 0);
      return json({ entries: r.results, total_ml: total });
    }
    if (endpoint === '/water' && method === 'POST') {
      const b = await readJsonObject(request);
      const date = b.date ? requireDate(b) : new Date().toISOString().slice(0, 10);
      const amount = b.amount_ml === undefined ? 250 : b.amount_ml;
      if (!Number.isInteger(amount) || amount < 1 || amount > 5000) throw Object.assign(new Error('amount_ml must be an integer between 1 and 5000'), { status: 400 });
      await env.DB.prepare('INSERT INTO water_log (date, amount_ml, created_at) VALUES (?, ?, datetime("now"))').bind(date, amount).run();
      const r = date
        ? await env.DB.prepare('SELECT SUM(amount_ml) as total FROM water_log WHERE date = ?').bind(date).first()
        : await env.DB.prepare("SELECT SUM(amount_ml) as total FROM water_log WHERE date = date('now')").first();
      return json({ success: true, total_ml: r ? r.total || amount : amount });
    }
    const waterDelMatch = endpoint.match(/^\/water\/(\d+)$/);
    if (waterDelMatch && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM water_log WHERE id = ?').bind(+waterDelMatch[1]).run();
      return json({ success: true });
    }

    /* Food Reviews */
    if (endpoint === '/food/reviews' && method === 'GET') {
      const date = new URL(request.url).searchParams.get('date');
      if (date) {
        const r = await env.DB.prepare('SELECT * FROM food_reviews WHERE date = ?').bind(date).first();
        return json({ review: r });
      }
      const r = await env.DB.prepare('SELECT * FROM food_reviews ORDER BY date DESC LIMIT 7').all();
      return json({ reviews: r.results });
    }
    if (endpoint === '/food/reviews' && method === 'POST') {
      const b = await readJsonObject(request);
      await env.DB.prepare('INSERT OR REPLACE INTO food_reviews (date, review, reviewer, created_at) VALUES (?, ?, ?, datetime("now"))').bind(requireDate(b), requireText(b, 'review', 6000), b.reviewer ? requireText(b, 'reviewer', 80) : 'AI').run();
      return json({ success: true });
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) { return json({ error: err.status && err.status < 500 ? err.message : 'Request failed' }, err.status || 500); }
}

/* ========================= MCP ========================= */

const MCP_TOOLS = [
  toolDefinition('hearth_status', 'Dashboard status', 'Read the current Hearth overview.', {}, true),
  toolDefinition('hearth_mood', 'Mood log', 'Read recent moods or record a mood.', {
    action: enumProperty(['get', 'set'], 'Whether to read or record a mood.'),
    partner: stringProperty('Partner name.', 80),
    mood: enumProperty(['great', 'good', 'okay', 'tired', 'stressed', 'low'], 'Mood to record.'),
    note: stringProperty('Optional private note.', 2000),
  }, false, ['action']),
  toolDefinition('hearth_note', 'Fridge notes', 'Read or leave a shared fridge note.', {
    action: enumProperty(['get', 'leave'], 'Whether to read or leave notes.'),
    limit: integerProperty('Number of notes to read.', 1, 20),
    from: stringProperty('Author name.', 80),
    content: stringProperty('Note text.', 4000),
  }, false, ['action']),
  toolDefinition('hearth_moment', 'Shared moments', 'List or add a dated shared moment.', {
    action: enumProperty(['list', 'add'], 'Whether to list or add moments.'),
    limit: integerProperty('Number of moments to read.', 1, 50),
    date: stringProperty('Date in YYYY-MM-DD format.', 10),
    title: stringProperty('Moment title.', 200),
    description: stringProperty('Optional description.', 4000),
  }, false, ['action']),
  toolDefinition('hearth_date', 'Important dates', 'Read upcoming dates or add one.', {
    action: enumProperty(['upcoming', 'add'], 'Whether to read or add dates.'),
    limit: integerProperty('Number of dates to read.', 1, 50),
    date: stringProperty('Date in YYYY-MM-DD format.', 10),
    title: stringProperty('Date title.', 200),
    recurring: { type: 'boolean', description: 'Whether this repeats yearly.' },
  }, false, ['action']),
  toolDefinition('hearth_shopping_list', 'Shopping list', 'Read unchecked shopping-list items.', {}, true),
  toolDefinition('hearth_shopping_add', 'Add shopping item', 'Add one item to the shopping list.', {
    item: stringProperty('Item to add.', 300),
    category: stringProperty('Optional category.', 100),
    added_by: stringProperty('Name of the person adding it.', 80),
  }, false, ['item']),
  toolDefinition('hearth_pressure', 'Pressure and migraine risk', 'Read current, historical, or forecast barometric pressure.', {
    action: enumProperty(['status', 'history', 'forecast'], 'Pressure view to return.'),
    hours: integerProperty('History window in hours.', 1, 720),
  }, true),
  toolDefinition('hearth_food_diary_today', 'Today food diary', 'Read today\'s meals, water and review status.', {}, true),
  toolDefinition('hearth_food_diary_history', 'Food diary history', 'Read food and water history over a bounded date range.', {
    days: integerProperty('Days to include when dates are omitted.', 1, 90),
    from: stringProperty('Start date in YYYY-MM-DD format.', 10),
    to: stringProperty('End date in YYYY-MM-DD format.', 10),
  }, true),
  toolDefinition('hearth_food_review', 'Save food review', 'Save or replace an AI food-diary review for a date.', {
    date: stringProperty('Date in YYYY-MM-DD format.', 10),
    review: stringProperty('Review text.', 6000),
    reviewer: stringProperty('Reviewer name.', 80),
  }, false, ['date', 'review']),
  toolDefinition('hearth_water_status', 'Water status', 'Read today\'s and recent water totals.', {}, true),
];

function stringProperty(description, maxLength) {
  return { type: 'string', description, minLength: 1, maxLength };
}

function integerProperty(description, minimum, maximum) {
  return { type: 'integer', description, minimum, maximum };
}

function enumProperty(values, description) {
  return { type: 'string', enum: values, description };
}

function toolDefinition(name, title, description, properties, readOnlyHint, required = []) {
  return {
    name, title, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { title, readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false },
  };
}

function rpcResult(id, result, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status,
    headers: securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
}

function rpcError(id, code, message, status = 200, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error }), {
    status,
    headers: securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
}

function validateMcpOrigin(request, config) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (origin === new URL(request.url).origin) return true;
  return config.MCP_ALLOWED_ORIGINS.includes(origin);
}

function validateArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const schema = tool.inputSchema;
  for (const required of schema.required || []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') return required + ' is required';
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) return 'unknown argument: ' + key;
    if (property.type === 'string') {
      if (typeof value !== 'string') return key + ' must be a string';
      if (property.minLength && value.length < property.minLength) return key + ' is too short';
      if (property.maxLength && value.length > property.maxLength) return key + ' is too long';
      if (property.enum && !property.enum.includes(value)) return key + ' must be one of: ' + property.enum.join(', ');
    } else if (property.type === 'integer') {
      if (!Number.isInteger(value) || value < property.minimum || value > property.maximum) return key + ' is out of range';
    } else if (property.type === 'boolean' && typeof value !== 'boolean') {
      return key + ' must be a boolean';
    }
  }
  const requiredForAction = {
    hearth_mood: { set: ['partner', 'mood'] },
    hearth_note: { leave: ['from', 'content'] },
    hearth_moment: { add: ['date', 'title'] },
    hearth_date: { add: ['date', 'title'] },
  };
  for (const key of requiredForAction[tool.name]?.[args.action] || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return key + ' is required for ' + args.action;
  }
  for (const key of ['date', 'from', 'to']) {
    if (args[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args[key])) return key + ' must use YYYY-MM-DD';
  }
  return null;
}

async function executeMcpTool(name, params, env, config) {
  switch (name) {
    case 'hearth_status': return mcpStatus(env, config);
    case 'hearth_mood': return mcpMood(env, params, config);
    case 'hearth_note': return mcpNote(env, params);
    case 'hearth_moment': return mcpMoment(env, params);
    case 'hearth_date': return mcpDate(env, params);
    case 'hearth_shopping_list': return mcpShoppingList(env);
    case 'hearth_shopping_add': return mcpShoppingAdd(env, params, config);
    case 'hearth_pressure': return mcpPressure(env, params);
    case 'hearth_food_diary_today': return mcpFoodDiaryToday(env, config);
    case 'hearth_food_diary_history': return mcpFoodDiaryHistory(env, params);
    case 'hearth_food_review': return mcpFoodReview(env, params);
    case 'hearth_water_status': return mcpWaterStatus(env);
    default: return null;
  }
}

function requiredScopeForCall(name, args) {
  if (name === 'hearth_shopping_add' || name === 'hearth_food_review') return 'hearth:write';
  if (name === 'hearth_mood' && args.action === 'set') return 'hearth:write';
  if (name === 'hearth_note' && args.action === 'leave') return 'hearth:write';
  if (name === 'hearth_moment' && args.action === 'add') return 'hearth:write';
  if (name === 'hearth_date' && args.action === 'add') return 'hearth:write';
  return 'hearth:read';
}

function visibleToolsForScopes(scopes) {
  if (scopes.includes('hearth:read') && scopes.includes('hearth:write')) return MCP_TOOLS;
  if (scopes.includes('hearth:read')) {
    return MCP_TOOLS.filter(tool => !['hearth_shopping_add', 'hearth_food_review'].includes(tool.name));
  }
  if (scopes.includes('hearth:write')) return MCP_TOOLS.filter(tool => !tool.annotations.readOnlyHint);
  return [];
}

async function handleMCP(request, env, config, remainder, scopes = []) {
  if (remainder && remainder !== '/') return json({ error: 'Not found' }, 404);
  if (!validateMcpOrigin(request, config)) return json({ error: 'Forbidden origin' }, 403);
  if (!(await withinRateLimit(env, request, 'mcp', 120, 60))) {
    return rpcError(null, -32000, 'Rate limit exceeded', 429);
  }
  if (request.method === 'GET') {
    return new Response(null, { status: 405, headers: securityHeaders({ 'Allow': 'POST' }) });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: securityHeaders({ 'Allow': 'POST' }) });

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) return rpcError(null, -32600, 'Content-Type must be application/json', 415);
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_JSON_BODY_BYTES) return rpcError(null, -32600, 'Request body is too large', 413);

  let message;
  try {
    const text = await request.text();
    if (encoder.encode(text).byteLength > MAX_JSON_BODY_BYTES) return rpcError(null, -32600, 'Request body is too large', 413);
    message = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, -32600, 'Invalid Request', 400);
  }

  if (message.method !== 'initialize') {
    const protocolVersion = request.headers.get('MCP-Protocol-Version');
    if (!protocolVersion || !MCP_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      return rpcError(message.id, -32600, 'Unsupported MCP protocol version', 400, { supported: MCP_PROTOCOL_VERSIONS });
    }
  }

  const isNotification = message.id === undefined;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    return new Response(null, { status: 202, headers: securityHeaders({ 'Cache-Control': 'no-store' }) });
  }
  if (isNotification) return new Response(null, { status: 202, headers: securityHeaders({ 'Cache-Control': 'no-store' }) });

  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    if (typeof requested !== 'string') return rpcError(message.id, -32602, 'protocolVersion is required', 400);
    const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
    return rpcResult(message.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'hearth-dash', version: '1.1.0' },
      instructions: 'Hearth is a private shared dashboard. Read tools do not change data; write tools change the shared household record.',
    });
  }

  if (message.method === 'ping') return rpcResult(message.id, {});
  if (message.method === 'tools/list') return rpcResult(message.id, { tools: visibleToolsForScopes(scopes) });
  if (message.method !== 'tools/call') return rpcError(message.id, -32601, 'Method not found');

  const name = message.params?.name;
  const args = message.params?.arguments || {};
  const tool = MCP_TOOLS.find(item => item.name === name);
  if (!tool) return rpcError(message.id, -32602, 'Unknown tool: ' + String(name));
  const validationError = validateArguments(tool, args);
  if (validationError) {
    return rpcResult(message.id, { content: [{ type: 'text', text: validationError }], isError: true });
  }
  const requiredScope = requiredScopeForCall(name, args);
  if (!scopes.includes(requiredScope)) {
    return rpcResult(message.id, {
      content: [{ type: 'text', text: `Permission denied: ${requiredScope} scope is required` }],
      isError: true,
    });
  }

  try {
    const toolResponse = await executeMcpTool(name, args, env, config);
    const data = await toolResponse.json();
    const isError = !toolResponse.ok || !!data.error;
    return rpcResult(message.id, {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
      isError,
    });
  } catch (error) {
    return rpcResult(message.id, { content: [{ type: 'text', text: 'Tool execution failed' }], isError: true });
  }
}

async function mcpStatus(env, config) {
  const [moodsP1, moodsP2, latestNote, nextDate] = await Promise.all([
    env.DB.prepare('SELECT * FROM moods WHERE partner = ? ORDER BY created_at DESC LIMIT 1').bind(config.PARTNER_1).first(),
    env.DB.prepare('SELECT * FROM moods WHERE partner = ? ORDER BY created_at DESC LIMIT 1').bind(config.PARTNER_2).first(),
    env.DB.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT 1').first(),
    env.DB.prepare('SELECT * FROM dates WHERE date >= date("now") ORDER BY date ASC LIMIT 1').first()
  ]);
  const moods = {};
  moods[config.PARTNER_1] = moodsP1;
  moods[config.PARTNER_2] = moodsP2;
  return json({ moods, latestNote, nextDate });
}

async function mcpMood(env, params, config) {
  if (params.action === 'get') { const r = await env.DB.prepare('SELECT * FROM moods WHERE partner = ? ORDER BY created_at DESC LIMIT 5').bind(params.partner || config.PARTNER_1).all(); return json({ moods: r.results }); }
  if (params.action === 'set') { await env.DB.prepare('INSERT INTO moods (partner, mood, note, created_at) VALUES (?, ?, ?, datetime("now"))').bind(params.partner, params.mood, params.note || null).run(); return json({ success: true, message: `Logged ${params.mood} mood for ${params.partner}` }); }
  return json({ error: 'Invalid action. Use: get, set' });
}

async function mcpNote(env, params) {
  if (params.action === 'get') { const r = await env.DB.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT ?').bind(params.limit || 5).all(); return json({ notes: r.results }); }
  if (params.action === 'leave') { await env.DB.prepare('INSERT INTO notes (from_partner, content, created_at) VALUES (?, ?, datetime("now"))').bind(params.from, params.content).run(); return json({ success: true }); }
  return json({ error: 'Invalid action. Use: get, leave' });
}

async function mcpMoment(env, params) {
  if (params.action === 'list') { const r = await env.DB.prepare('SELECT * FROM moments ORDER BY date DESC LIMIT ?').bind(params.limit || 10).all(); return json({ moments: r.results }); }
  if (params.action === 'add') { await env.DB.prepare('INSERT INTO moments (date, title, description, created_at) VALUES (?, ?, ?, datetime("now"))').bind(params.date, params.title, params.description || null).run(); return json({ success: true }); }
  return json({ error: 'Invalid action. Use: list, add' });
}

async function mcpDate(env, params) {
  if (params.action === 'upcoming') { const r = await env.DB.prepare('SELECT * FROM dates WHERE date >= date("now") ORDER BY date ASC LIMIT ?').bind(params.limit || 5).all(); return json({ dates: r.results }); }
  if (params.action === 'add') { await env.DB.prepare('INSERT INTO dates (date, title, recurring, created_at) VALUES (?, ?, ?, datetime("now"))').bind(params.date, params.title, params.recurring ? 1 : 0).run(); return json({ success: true }); }
  return json({ error: 'Invalid action. Use: upcoming, add' });
}

async function mcpShoppingList(env) {
  const r = await env.DB.prepare('SELECT * FROM shopping WHERE checked = 0 ORDER BY category, created_at DESC').all();
  const items = r.results || [];
  const groups = {};
  items.forEach(i => { if (!groups[i.category]) groups[i.category] = []; groups[i.category].push(i.item); });
  return json({ items, count: items.length, by_category: groups });
}

async function mcpShoppingAdd(env, params, config) {
  const item = params.item;
  if (!item) return json({ error: 'item is required' }, 400);
  const category = params.category || 'Other';
  const added_by = params.added_by || config.PARTNER_2;
  await env.DB.prepare('INSERT INTO shopping (item, category, checked, added_by, created_at) VALUES (?, ?, 0, ?, datetime("now"))').bind(item, category, added_by).run();
  return json({ success: true, message: `Added "${item}" to ${category}` });
}

async function mcpPressure(env, params) {
  const action = params.action || 'status';
  if (action === 'status') {
    const key = env.WEATHER_API_KEY;
    const lat = env.WEATHER_LAT;
    const lon = env.WEATHER_LON;
    if (!key) return json({ error: 'No weather API key configured' });
    const [currentRes, forecastRes, hist6h] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${key}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${key}`),
      env.DB.prepare("SELECT pressure_hpa FROM pressure_log WHERE recorded_at <= datetime('now', '-5 hours') ORDER BY recorded_at DESC LIMIT 1").first().catch(() => null)
    ]);
    if (!currentRes.ok) return json({ error: 'Weather API error' });
    const w = await currentRes.json();
    const pressure = w.main.pressure;
    let shift6hPast = hist6h ? pressure - hist6h.pressure_hpa : 0;
    let shift6hFuture = 0, shift24hFuture = 0;
    if (forecastRes.ok) {
      const fc = await forecastRes.json();
      const now = Date.now();
      let c6 = null, c24 = null, m6 = Infinity, m24 = Infinity;
      (fc.list || []).forEach(f => {
        const fts = new Date(f.dt_txt + 'Z').getTime();
        if (Math.abs(fts - (now + 6*3600000)) < m6) { m6 = Math.abs(fts - (now + 6*3600000)); c6 = f; }
        if (Math.abs(fts - (now + 24*3600000)) < m24) { m24 = Math.abs(fts - (now + 24*3600000)); c24 = f; }
      });
      if (c6) shift6hFuture = c6.main.pressure - pressure;
      if (c24) shift24hFuture = c24.main.pressure - pressure;
    }
    const maxShift6h = Math.max(Math.abs(shift6hPast), Math.abs(shift6hFuture));
    const shift24hAbs = Math.abs(shift24hFuture);
    let alert = 'none';
    if (maxShift6h >= 12 || shift24hAbs >= 20) alert = 'critical';
    else if (maxShift6h >= 8 || shift24hAbs >= 15) alert = 'warning';
    else if (maxShift6h >= 4 || shift24hAbs >= 10) alert = 'watch';
    const trend = shift6hFuture < -2 ? 'falling' : shift6hFuture > 2 ? 'rising' : 'stable';
    return json({ pressure_hpa: pressure, trend, shift_6h_past: Math.round(shift6hPast * 10) / 10, shift_6h_future: Math.round(shift6hFuture * 10) / 10, shift_24h_future: Math.round(shift24hFuture * 10) / 10, alert, message: alert === 'none' ? 'Pressure stable.' : `Pressure ${trend} — ${alert} level shift detected.` });
  }
  if (action === 'history') {
    const hours = params.hours || 72;
    const r = await env.DB.prepare(`SELECT pressure_hpa, temp, recorded_at FROM pressure_log WHERE recorded_at >= datetime('now', '-${Math.min(hours, 720)} hours') ORDER BY recorded_at ASC`).all();
    return json({ readings: r.results || [], count: r.results ? r.results.length : 0 });
  }
  if (action === 'forecast') {
    const key = env.WEATHER_API_KEY;
    if (!key) return json({ error: 'No weather API key configured' });
    const res = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${env.WEATHER_LAT}&lon=${env.WEATHER_LON}&units=metric&appid=${key}`);
    if (!res.ok) return json({ error: 'Forecast API error' });
    const fc = await res.json();
    const points = (fc.list || []).map(f => ({ pressure: f.main.pressure, temp: Math.round(f.main.temp), time: f.dt_txt }));
    return json({ forecast: points, count: points.length });
  }
  return json({ error: 'Invalid action. Use: status, history, forecast' });
}

async function mcpFoodDiaryToday(env, config) {
  const [meals, water, review] = await Promise.all([
    env.DB.prepare("SELECT * FROM food_diary WHERE date = date('now') ORDER BY time ASC").all(),
    env.DB.prepare("SELECT SUM(amount_ml) as total FROM water_log WHERE date = date('now')").first(),
    env.DB.prepare("SELECT * FROM food_reviews WHERE date = date('now')").first()
  ]);
  const entries = (meals.results || []).map(m => ({ id: m.id, meal_type: m.meal_type, time: m.time, note: m.note, has_photo: !!m.photo_key }));
  const mealTypes = entries.map(e => e.meal_type);
  const logged = { breakfast: mealTypes.includes('breakfast'), lunch: mealTypes.includes('lunch'), dinner: mealTypes.includes('dinner') };
  const waterTotal = water ? water.total || 0 : 0;
  return json({ date: new Date().toISOString().slice(0, 10), meals: entries, meals_logged: entries.length, logged, water_ml: waterTotal, water_glasses: Math.floor(waterTotal / 250), water_target_ml: 2000, has_review: !!review, review: review ? review.review : null });
}

async function mcpFoodDiaryHistory(env, params) {
  const days = params.days || 7;
  const from = params.from || new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = params.to || new Date().toISOString().slice(0, 10);
  const [meals, water, reviews] = await Promise.all([
    env.DB.prepare('SELECT * FROM food_diary WHERE date >= ? AND date <= ? ORDER BY date DESC, time ASC').bind(from, to).all(),
    env.DB.prepare('SELECT date, SUM(amount_ml) as total FROM water_log WHERE date >= ? AND date <= ? GROUP BY date').bind(from, to).all(),
    env.DB.prepare('SELECT * FROM food_reviews WHERE date >= ? AND date <= ? ORDER BY date DESC').bind(from, to).all()
  ]);
  const dayMap = {};
  (meals.results || []).forEach(m => { if (!dayMap[m.date]) dayMap[m.date] = { meals: [], water_ml: 0 }; dayMap[m.date].meals.push({ meal_type: m.meal_type, time: m.time, note: m.note }); });
  (water.results || []).forEach(w => { if (!dayMap[w.date]) dayMap[w.date] = { meals: [], water_ml: 0 }; dayMap[w.date].water_ml = w.total; });
  const allDates = Object.keys(dayMap).sort();
  const skippedBreakfasts = allDates.filter(d => !dayMap[d].meals.some(m => m.meal_type === 'breakfast')).length;
  const avgWater = allDates.length ? allDates.reduce((s, d) => s + (dayMap[d].water_ml || 0), 0) / allDates.length : 0;
  return json({ from, to, days_logged: allDates.length, daily: dayMap, patterns: { skipped_breakfasts: skippedBreakfasts, avg_water_ml: Math.round(avgWater) }, reviews: (reviews.results || []).map(r => ({ date: r.date, review: r.review })) });
}

async function mcpFoodReview(env, params) {
  if (!params.date || !params.review) return json({ error: 'date and review are required' }, 400);
  await env.DB.prepare('INSERT OR REPLACE INTO food_reviews (date, review, reviewer, created_at) VALUES (?, ?, ?, datetime("now"))').bind(params.date, params.review, params.reviewer || 'AI').run();
  return json({ success: true, message: 'Review for ' + params.date + ' saved' });
}

async function mcpWaterStatus(env) {
  const [todayResult, weekResult] = await Promise.all([
    env.DB.prepare("SELECT SUM(amount_ml) as total, COUNT(*) as entries FROM water_log WHERE date = date('now')").first(),
    env.DB.prepare("SELECT date, SUM(amount_ml) as total FROM water_log WHERE date >= date('now', '-7 days') GROUP BY date ORDER BY date").all()
  ]);
  const todayTotal = todayResult ? todayResult.total || 0 : 0;
  const target = 2000;
  const weekDays = (weekResult.results || []);
  const avgWeek = weekDays.length ? weekDays.reduce((s, d) => s + d.total, 0) / weekDays.length : 0;
  let message = '';
  if (todayTotal === 0) message = 'No water logged today yet.';
  else if (todayTotal < 500) message = 'Barely any water today. Needs more.';
  else if (todayTotal < 1000) message = 'Under halfway. Needs more water.';
  else if (todayTotal < 1500) message = 'Getting there but still under target.';
  else if (todayTotal < 2000) message = 'Almost at target. One more glass.';
  else message = 'Hit the target today.';
  return json({ date: new Date().toISOString().slice(0, 10), today_ml: todayTotal, today_glasses: Math.floor(todayTotal / 250), target_ml: target, percent: Math.round((todayTotal / target) * 100), entries_today: todayResult ? todayResult.entries || 0 : 0, week_avg_ml: Math.round(avgWeek), week_days: weekDays, message });
}

/* ========================= PHOTO HANDLERS ========================= */

async function handleFoodPhotoUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('photo');
    if (!file || !file.size) return json({ error: 'No photo provided' }, 400);
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    if (!allowed.includes(file.type)) return json({ error: 'Invalid file type' }, 400);
    if (file.size > 5 * 1024 * 1024) return json({ error: 'Photo too large (max 5MB)' }, 400);
    const date = new Date().toISOString().slice(0, 10);
    const id = crypto.randomUUID().slice(0, 8);
    const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1];
    const key = 'food/' + date + '/' + id + '.' + ext;
    await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    return json({ success: true, key });
  } catch (err) { return json({ error: 'Upload failed' }, 500); }
}

async function handleFoodPhotoServe(key, env) {
  try {
    const object = await env.PHOTOS.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'");
    return new Response(object.body, { headers });
  } catch (err) { return new Response('Could not load photo', { status: 500 }); }
}

/* ========================= WEATHER ========================= */

let weatherCache = { data: null, ts: 0 };
const WEATHER_CACHE_MS = 30 * 60 * 1000;

async function handleWeather(env) {
  const now = Date.now();
  if (weatherCache.data && (now - weatherCache.ts) < WEATHER_CACHE_MS) {
    return json(weatherCache.data);
  }
  try {
    const key = env.WEATHER_API_KEY;
    const lat = env.WEATHER_LAT;
    const lon = env.WEATHER_LON;
    if (!key) return json({ error: 'No weather API key configured' }, 500);
    const [currentRes, forecastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${key}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${key}`)
    ]);
    if (!currentRes.ok) return json({ error: 'Weather API error', status: currentRes.status }, 502);
    const w = await currentRes.json();
    const fc = forecastRes.ok ? await forecastRes.json() : null;
    const pressure = w.main.pressure;
    const temp = Math.round(w.main.temp);

    try { await env.DB.prepare('INSERT INTO pressure_log (pressure_hpa, temp, recorded_at) VALUES (?, ?, datetime("now"))').bind(pressure, w.main.temp).run(); } catch(e) {}

    let shift6hPast = 0;
    try { const hist = await env.DB.prepare("SELECT pressure_hpa FROM pressure_log WHERE recorded_at <= datetime('now', '-5 hours') ORDER BY recorded_at DESC LIMIT 1").first(); if (hist) shift6hPast = pressure - hist.pressure_hpa; } catch(e) {}

    let shift6hFuture = 0, shift24hFuture = 0, pressureTrend = 'stable';
    if (fc && fc.list) {
      const target6h = now + 6 * 3600000;
      const target24h = now + 24 * 3600000;
      let c6 = null, c24 = null, m6 = Infinity, m24 = Infinity;
      fc.list.forEach(f => {
        const fts = new Date(f.dt_txt + 'Z').getTime();
        if (Math.abs(fts - target6h) < m6) { m6 = Math.abs(fts - target6h); c6 = f; }
        if (Math.abs(fts - target24h) < m24) { m24 = Math.abs(fts - target24h); c24 = f; }
      });
      if (c6) shift6hFuture = c6.main.pressure - pressure;
      if (c24) shift24hFuture = c24.main.pressure - pressure;
    }
    if (shift6hFuture < -2) pressureTrend = 'falling';
    else if (shift6hFuture > 2) pressureTrend = 'rising';

    const maxShift6h = Math.max(Math.abs(shift6hPast), Math.abs(shift6hFuture));
    const shift24hAbs = Math.abs(shift24hFuture);
    let shiftAlert = 'none';
    if (maxShift6h >= 12 || shift24hAbs >= 20) shiftAlert = 'critical';
    else if (maxShift6h >= 8 || shift24hAbs >= 15) shiftAlert = 'warning';
    else if (maxShift6h >= 4 || shift24hAbs >= 10) shiftAlert = 'watch';

    let migraineRisk = 'low', migraineNote = 'Pressure stable';
    if (pressure < 1000) { migraineRisk = 'high'; migraineNote = 'Very low pressure — migraine risk elevated'; }
    else if (pressure < 1005) { migraineRisk = 'moderate'; migraineNote = 'Low pressure — watch for symptoms'; }
    else if (pressure > 1030) { migraineRisk = 'moderate'; migraineNote = 'High pressure — some sensitivity possible'; }
    if (shiftAlert === 'critical' || shiftAlert === 'warning') {
      migraineRisk = 'high';
      const dir = pressureTrend === 'falling' ? 'dropping' : pressureTrend === 'rising' ? 'rising' : 'shifting';
      migraineNote = 'Rapid pressure ' + dir + ' — migraine risk elevated';
    } else if (shiftAlert === 'watch' && migraineRisk === 'low') {
      migraineRisk = 'moderate'; migraineNote = 'Pressure shifting — monitor for symptoms';
    }

    const data = {
      temp, feels_like: Math.round(w.main.feels_like), description: w.weather[0].description,
      icon: w.weather[0].icon, humidity: w.main.humidity, pressure,
      wind: Math.round(w.wind.speed * 2.237), migraine_risk: migraineRisk, migraine_note: migraineNote,
      pressure_trend: pressureTrend, shift_6h_past: Math.round(shift6hPast * 10) / 10,
      shift_6h_future: Math.round(shift6hFuture * 10) / 10, shift_24h_future: Math.round(shift24hFuture * 10) / 10,
      shift_alert: shiftAlert, location: w.name, updated: new Date().toISOString()
    };
    weatherCache = { data, ts: now };
    return json(data);
  } catch (err) { return json({ error: 'Failed to fetch weather' }, 500); }
}

/* ========================= PRESSURE HISTORY ========================= */

async function handlePressure(env) {
  try {
    const key = env.WEATHER_API_KEY;
    const lat = env.WEATHER_LAT;
    const lon = env.WEATHER_LON;
    const [histResult, forecastRes] = await Promise.all([
      env.DB.prepare("SELECT pressure_hpa, temp, recorded_at FROM pressure_log WHERE recorded_at >= datetime('now', '-72 hours') ORDER BY recorded_at ASC").all(),
      key ? fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${key}`) : Promise.resolve(null)
    ]);
    const history = histResult.results || [];
    let forecast = [];
    if (forecastRes && forecastRes.ok) {
      const fc = await forecastRes.json();
      forecast = (fc.list || []).map(f => ({ pressure: f.main.pressure, dt_txt: f.dt_txt }));
    }
    let current = null;
    if (history.length) {
      const last = history[history.length - 1];
      current = { pressure: last.pressure_hpa, timestamp: last.recorded_at };
    }
    return json({ history, forecast, current, migraine_days: [] });
  } catch (err) { return json({ error: 'Pressure data error' }, 500); }
}

/* ========================= UTILITIES ========================= */

function getCookie(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function readJsonObject(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  }
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_JSON_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { status: 413 });
  const text = await request.text();
  if (encoder.encode(text).byteLength > MAX_JSON_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { status: 413 });
  let value;
  try { value = JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('JSON body must be an object'), { status: 400 });
  return value;
}

function requireText(body, key, maxLength, allowed) {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(key + ' is required'), { status: 400 });
  if (value.length > maxLength) throw Object.assign(new Error(key + ' is too long'), { status: 400 });
  if (allowed && !allowed.includes(value)) throw Object.assign(new Error(key + ' is invalid'), { status: 400 });
  return value.trim();
}

function optionalText(body, key, maxLength) {
  if (body[key] === undefined || body[key] === null || body[key] === '') return null;
  return requireText(body, key, maxLength);
}

function requireDate(body, key = 'date') {
  const value = requireText(body, key, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error(key + ' must use YYYY-MM-DD'), { status: 400 });
  return value;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
}
