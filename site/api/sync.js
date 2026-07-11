const { DEFAULT_MODEL, runSync } = require('../lib/pipeline');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  const tavilyKey = process.env.TAVILY_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  let model = DEFAULT_MODEL;
  try {
    // Vercel's Node runtime pre-parses JSON bodies into req.body
    const parsed = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    if (parsed.model) model = parsed.model;
  } catch (e) { /* ignore malformed body, use default model */ }

  if (!tavilyKey || !openrouterKey) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Missing TAVILY_API_KEY and/or OPENROUTER_API_KEY — add them in Vercel Project Settings → Environment Variables and redeploy.' }));
  }

  // NDJSON progress lines, same protocol as the local server. If the platform
  // buffers the response the frontend still works — it just sees all the
  // agent events arrive at once when the sync finishes.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const emit = obj => res.write(JSON.stringify(obj) + '\n');

  try {
    const { updates, syncedAt } = await runSync({ tavilyKey, openrouterKey, model, emit });
    emit({ done: true, updates, syncedAt });
  } catch (e) {
    emit({ error: e.message || 'Sync failed' });
  }
  res.end();
};
