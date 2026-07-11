// Local dev server — serves the static frontend and the same API the Vercel
// functions in api/ provide in production. The sync logic lives in
// lib/pipeline.js, shared between both.
const http = require('http');
const fs = require('fs');
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
  // no .env file yet — TAVILY_API_KEY / OPENROUTER_API_KEY simply won't be set
}

const { DEFAULT_MODEL, runSync } = require('./lib/pipeline');
const { searchShips } = require('./lib/ships');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
};

function handleStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    tavilyConfigured: !!process.env.TAVILY_API_KEY,
    openrouterConfigured: !!process.env.OPENROUTER_API_KEY,
    model: DEFAULT_MODEL
  }));
}

function handleSync(req, res) {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    const tavilyKey = process.env.TAVILY_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    let model = DEFAULT_MODEL;
    try {
      const parsed = JSON.parse(body || '{}');
      if (parsed.model) model = parsed.model;
    } catch (e) { /* ignore malformed body, use default model */ }

    if (!tavilyKey || !openrouterKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Server is missing TAVILY_API_KEY and/or OPENROUTER_API_KEY. Add them to a .env file next to server.js and restart the server.' }));
    }

    // Stream progress as NDJSON so the frontend can show each agent working.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
    const emit = obj => res.write(JSON.stringify(obj) + '\n');

    try {
      const { updates, syncedAt } = await runSync({ tavilyKey, openrouterKey, model, emit });
      emit({ done: true, updates, syncedAt });
    } catch (e) {
      emit({ error: e.message || 'Sync failed' });
    }
    res.end();
  });
}

async function handleShips(req, res) {
  const q = (new URL(req.url, 'http://localhost').searchParams.get('q') || '').trim();
  res.setHeader('Content-Type', 'application/json');
  if (q.length < 2) return res.end(JSON.stringify({ ships: [] }));
  try {
    const ships = await searchShips(q);
    res.end(JSON.stringify({ ships }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message || 'Ship search failed' }));
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/sync') {
    return handleSync(req, res);
  }
  if (req.method === 'GET' && req.url === '/api/status') {
    return handleStatus(req, res);
  }
  if (req.method === 'GET' && req.url.startsWith('/api/ships')) {
    return handleShips(req, res);
  }

  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(ROOT, relPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    // no-cache so a plain reload always picks up the latest app.js/css —
    // a stale cached app.js against a newer API breaks the sync stream.
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=86400' : 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Port Congestion Monitor running at http://localhost:${PORT}`);
});
