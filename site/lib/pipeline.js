// Shared sync pipeline — used by both server.js (local dev) and the Vercel
// serverless functions in api/.
//
// Three agents run in sequence:
//   1. fetcher — gathers live provider data (GoComet, Portcast)
//      and Tavily search snippets. Pure I/O, no LLM.
//   2. analyst — LLM pass that reads the fetched data and writes plain-text
//      analyst notes per port (levels, trends, summaries, cited sources).
//   3. writer  — LLM pass that converts the notes into the strict JSON the
//      frontend consumes; validated, with one retry on schema problems.

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-3-flash-preview';

// portcastSlug: path segment of www.portcast.io/port-congestion/<slug>.
// Note KRPUS is 'busan' (the main hub) — 'south-busan' is a different, minor port.
const PORTS = [
  { id: 'SGSIN', name: 'Singapore', country: 'Singapore', portcastSlug: 'singapore' },
  { id: 'USHOU', name: 'Houston', country: 'United States', portcastSlug: 'houston' },
  { id: 'INMUN', name: 'Mundra', country: 'India', portcastSlug: 'mundra' },
  { id: 'NLRTM', name: 'Rotterdam', country: 'Netherlands', portcastSlug: 'rotterdam' },
  { id: 'INNSA', name: 'Nhava Sheva', country: 'India', portcastSlug: 'nhava-sheva' },
  { id: 'SAJED', name: 'Jeddah', country: 'Saudi Arabia', portcastSlug: 'jeddah' },
  { id: 'AEJEA', name: 'Jebel Ali', country: 'United Arab Emirates', portcastSlug: 'jebel-ali' },
  { id: 'KRPUS', name: 'Busan', country: 'South Korea', portcastSlug: 'busan' },
  { id: 'JPKWS', name: 'Kawasaki', country: 'Japan', portcastSlug: 'kawasaki' }
];

// Data sources (for now): GoComet's public real-time tracker, Portcast's
// per-port pages (structured numbers scraped from each) + Tavily search restricted to the domains below for
// qualitative context.
const DATA_DOMAINS = ['gocomet.com', 'portcast.io'];
const GOCOMET_URL = 'https://www.gocomet.com/real-time-port-congestion';

async function fetchGoComet() {
  const res = await fetch(GOCOMET_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) throw new Error(`GoComet ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('GoComet page layout changed — __NEXT_DATA__ not found');
  const props = JSON.parse(m[1]);
  const entries = props && props.props && props.props.pageProps && props.props.pageProps.ssrCongestionData;
  if (!Array.isArray(entries)) throw new Error('GoComet congestion data missing from page');
  const byCode = {};
  for (const e of entries) {
    if (e && e.port && e.port.code) byCode[e.port.code] = e;
  }
  return byCode;
}

const PORTCAST_BASE = 'https://www.portcast.io/port-congestion/';

// Portcast per-port pages embed a schema.org Dataset (JSON-LD) with the
// weekly congestion metrics — median waiting time, category, vessels waiting.
async function fetchPortcast(port) {
  const url = PORTCAST_BASE + port.portcastSlug;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) throw new Error(`Portcast ${res.status}`);
  const html = await res.text();
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    let j;
    try { j = JSON.parse(m[1]); } catch (e) { continue; }
    if (!j || j['@type'] !== 'Dataset') continue;
    const v = {};
    for (const p of j.variableMeasured || []) v[p.name] = p.value;
    const waitDays = parseFloat(v['Median Waiting Time (Current Week)']);
    if (!Number.isFinite(waitDays)) break;
    const vessels = parseInt(v['Average Vessels Waiting per Day at Anchorage'], 10);
    return {
      url,
      waitDays,
      lastWeekDays: parseFloat(v['Median Waiting Time (Last Week)']),
      changePct: String(v['Median Waiting Time Change'] || ''),
      category: String(v['Congestion Category'] || ''),
      vessels: Number.isFinite(vessels) ? vessels : null
    };
  }
  throw new Error('Portcast page layout changed — congestion Dataset not found');
}

// Deterministic cross-check of the two waiting-time providers, both measured
// in days. "agree" within half a day; otherwise the headline figure is their
// average.
function compareProviders(gcEntry, pc) {
  const gcDays = gcEntry && gcEntry.port && Number.isFinite(+gcEntry.port.delay) ? +gcEntry.port.delay : null;
  const pcDays = pc && Number.isFinite(pc.waitDays) ? pc.waitDays : null;
  if (gcDays === null && pcDays === null) return null;
  const both = gcDays !== null && pcDays !== null;
  const any = gcDays !== null || pcDays !== null;
  const avgDays = both ? (gcDays + pcDays) / 2 : (gcDays !== null ? gcDays : pcDays);
  return {
    gocomet: gcDays === null ? null : { days: gcDays, level: gcEntry.port.delayLevel },
    portcast: pcDays === null ? null : { days: pcDays, level: pc.category, vessels: pc.vessels, changePct: pc.changePct },
    agree: both ? Math.abs(gcDays - pcDays) <= 0.5 : null,
    avgDays: any ? Math.round(avgDays * 100) / 100 : null
  };
}

async function tavilySearch(apiKey, port) {
  const query = `${port.name} ${port.country} port congestion vessel delays waiting berth`;
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ query, topic: 'general', max_results: 5, include_answer: 'basic', include_domains: DATA_DOMAINS })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function goCometBlock(entry) {
  if (!entry) return 'GOCOMET LIVE DATA: not available for this port code.';
  const p = entry.port;
  return [
    'GOCOMET LIVE DATA (structured, authoritative — anchor your numbers on this):',
    `- current vessel delay: ${p.delay} days (GoComet level: "${p.delayLevel}")`,
    `- weekly median delay: ${entry.weekly_median_delay} days (weekly max: ${entry.weekly_max_delay})`,
    `- fortnightly median delay: ${entry.fortnightly_median_delay} days (max: ${entry.fortnightly_max_delay})`,
    `- monthly median delay: ${entry.monthly_median_delay} days (max: ${entry.monthly_max_delay})`
  ].join('\n');
}

function portcastBlock(pc) {
  if (!pc) return 'PORTCAST LIVE DATA: not available for this port.';
  return [
    'PORTCAST LIVE DATA (structured, authoritative — anchor your numbers on this):',
    `- median waiting time this week: ${pc.waitDays} days (last week: ${pc.lastWeekDays} days, week-over-week change: ${pc.changePct})`,
    `- congestion category: "${pc.category}"`,
    `- average vessels waiting per day at anchorage: ${pc.vessels === null ? 'n/a' : pc.vessels}`,
    `- source url: ${pc.url}`
  ].join('\n');
}

function buildDataBlocks(portResults, goComet, portcast) {
  return portResults.map(({ port, data, error }) => {
    const live = goCometBlock(goComet && goComet[port.id]) + '\n\n' + portcastBlock(portcast[port.id]);
    let search;
    if (error) {
      search = `Search failed (${error}).`;
    } else {
      const answer = data.answer ? `Summary: ${data.answer}\n` : '';
      const results = (data.results || []).slice(0, 5)
        .map(r => `- [${r.title}] <${r.url}>${r.published_date ? ' (' + r.published_date + ')' : ''}: ${(r.content || '').slice(0, 500)}`)
        .join('\n');
      search = `${answer}${results || 'No results found.'}`;
    }
    return `PORT ${port.id} (${port.name}, ${port.country}):\n${live}\n\nSearch context (${DATA_DOMAINS.join(' / ')}):\n${search}`;
  }).join('\n\n');
}

// Agent 2 — "Analyst": reads the fetched data, decides every value, and
// writes plain-text notes per port. It does NOT produce JSON.
function buildAnalystPrompt(portResults, goComet, portcast) {
  const ids = portResults.map(r => r.port.id).join(', ');
  const blocks = buildDataBlocks(portResults, goComet, portcast);

  return `You are the ANALYST agent in a three-agent pipeline (fetcher → analyst → JSON writer). The fetcher agent gathered the live provider data and search snippets below. Analyze current conditions and write concise plain-text analyst notes — one block per port, covering all of these port codes in this order: ${ids}.

Write each block in exactly this shape (plain text, NO JSON, no markdown):
PORT <code>
level: <low|moderate|high|severe>
vessels: <integer, vessels waiting at anchorage — copy Portcast's average vessels waiting per day exactly; if Portcast has no figure, estimate and lower conf>
waitH: <integer, average waiting time in hours>
berth: <integer 0-100, berth utilization percent>
trend: <improving|stable|worsening>
conf: <low|medium|high>
summary: <1-2 sentences on current conditions>
dataQuality: <1 sentence noting source agreement or gaps>
sources:
- <title> | <outlet> | <date> | <signal, a short phrase like "~12 vessels waiting"> | <url copied EXACTLY from the data above — never invent or modify a URL; for GoComet live data use ${GOCOMET_URL}>
(up to 3 source lines per port)

Rules for using the live provider data, when present for a port:
- CROSS-CHECK the two providers: GoComet's current vessel delay vs Portcast's median waiting time this week (both in days). If both are present, waitH = the AVERAGE of the two, converted to hours and rounded. If only one is present, use that one.
- In dataQuality, state both providers' figures and whether they agree, e.g. "GoComet reports 2 days vs Portcast 0.1 days — figures diverge; headline wait is the average of both." If they are within half a day of each other, say they agree.
- vessels: comes ONLY from Portcast's average vessels waiting per day at anchorage. If Portcast has no figure for the port, estimate from context and say so in dataQuality.
- level: weigh both providers' categories (map "medium" → "moderate"); if they disagree, pick the middle ground; use "severe" only if delays run 7 days or more.
- trend: use Portcast's week-over-week change and GoComet's weekly vs monthly medians — improving if falling, worsening if rising, else stable.
- conf: "high" when both providers have data and roughly agree; "medium" when they diverge strongly or only one provider has data; "low" when neither does.
- Cite BOTH providers as sources when both have data — outlet "GoComet" (url "${GOCOMET_URL}") and outlet "Portcast" (its "source url" above), each with its own signal like "2-day vessel delay" / "0.1-day median wait".
- berth is NOT directly in the provider data — estimate it plausibly and note in dataQuality that it is an estimate.
If neither provider has data for a port, fall back to the search snippets and mark confidence "low".
If snippets are sparse or contradictory, make a reasonable best-effort estimate and lower confidence rather than omitting a port.

DATA GATHERED BY THE FETCHER AGENT:

${blocks}`;
}

// Agent 3 — "JSON Writer": converts the analyst's notes into the strict
// JSON schema the frontend consumes. Formatting only — no re-analysis.
function buildWriterPrompt(ids, analysis) {
  return `You are the JSON WRITER agent in a three-agent pipeline (fetcher → analyst → JSON writer). Convert the analyst agent's notes below into a JSON array with exactly one object per port, covering all of these port codes in this order: ${ids}.

Each object must have exactly these fields:
- id (string, the port code exactly as given)
- level ("low"|"moderate"|"high"|"severe")
- vessels (integer)
- waitH (integer, hours)
- berth (integer 0-100)
- trend ("improving"|"stable"|"worsening")
- conf ("low"|"medium"|"high")
- summary (string)
- dataQuality (string)
- sources (array of up to 3 objects: {title, outlet, date, signal, url} — one per source line in the notes)

Copy every value faithfully from the notes — do NOT re-analyze, round differently, or invent anything. URLs must be copied character-for-character. If a note line is missing or malformed, pick the closest valid enum value and keep going. Output ONLY the raw JSON array — no markdown code fences, no commentary.

ANALYST NOTES:

${analysis}`;
}

// Cheap structural check of the writer's output; returns a list of problems
// (empty = valid) so the writer agent can be retried with feedback.
function validateUpdates(updates) {
  const problems = [];
  if (!Array.isArray(updates)) return ['output is not a JSON array'];
  const seen = new Set(updates.map(u => u && u.id));
  for (const port of PORTS) {
    if (!seen.has(port.id)) problems.push(`missing port ${port.id}`);
  }
  updates.forEach((u, i) => {
    if (!u || typeof u !== 'object') { problems.push(`item ${i} is not an object`); return; }
    if (!['low', 'moderate', 'high', 'severe'].includes(u.level)) problems.push(`${u.id || i}: bad level "${u.level}"`);
    if (!['improving', 'stable', 'worsening'].includes(u.trend)) problems.push(`${u.id || i}: bad trend "${u.trend}"`);
    if (!['low', 'medium', 'high'].includes(u.conf)) problems.push(`${u.id || i}: bad conf "${u.conf}"`);
    if (!Number.isFinite(+u.waitH)) problems.push(`${u.id || i}: waitH is not a number`);
    if (!Number.isFinite(+u.vessels)) problems.push(`${u.id || i}: vessels is not a number`);
  });
  return problems;
}

async function openRouterComplete(apiKey, model, prompt, systemPrompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Port Congestion Monitor'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt || 'You output only valid JSON. No prose, no markdown fences.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('OpenRouter returned no content');
  return content;
}

function extractJsonArray(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in model output');
  return JSON.parse(t.slice(start, end + 1));
}

async function agentFetcher(tavilyKey) {
  const [goComet, portcastList, portResults] = await Promise.all([
    fetchGoComet().catch(e => {
      console.warn('GoComet fetch failed, continuing without it:', e.message);
      return null;
    }),
    Promise.all(PORTS.map(port =>
      fetchPortcast(port).catch(e => {
        console.warn(`Portcast fetch failed for ${port.id}, continuing without it:`, e.message);
        return null;
      })
    )),
    Promise.all(PORTS.map(async port => {
      try {
        const data = await tavilySearch(tavilyKey, port);
        return { port, data };
      } catch (e) {
        return { port, error: e.message };
      }
    }))
  ]);

  const portcast = {};
  PORTS.forEach((port, i) => {
    portcast[port.id] = portcastList[i];
  });

  return {
    goComet, portcast, portResults,
    counts: {
      gocomet: goComet ? PORTS.filter(p => goComet[p.id]).length : 0,
      portcast: portcastList.filter(Boolean).length,
      searches: portResults.filter(r => !r.error).length
    }
  };
}

async function agentAnalyst(openrouterKey, model, fetched) {
  const prompt = buildAnalystPrompt(fetched.portResults, fetched.goComet, fetched.portcast);
  return openRouterComplete(openrouterKey, model, prompt,
    'You are a careful maritime data analyst. You write concise plain-text notes in exactly the requested shape. No JSON, no markdown.');
}

async function agentWriter(openrouterKey, model, analysis) {
  const ids = PORTS.map(p => p.id).join(', ');
  let prompt = buildWriterPrompt(ids, analysis);
  let lastProblems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await openRouterComplete(openrouterKey, model, prompt);
    let updates;
    try {
      updates = extractJsonArray(content);
    } catch (e) {
      lastProblems = [e.message];
      prompt = buildWriterPrompt(ids, analysis) + `\n\nYour previous output could not be parsed (${e.message}). Output the corrected raw JSON array only.`;
      continue;
    }
    lastProblems = validateUpdates(updates);
    if (!lastProblems.length) return updates;
    prompt = buildWriterPrompt(ids, analysis) + `\n\nYour previous output had these problems:\n- ${lastProblems.join('\n- ')}\nOutput the corrected raw JSON array only.`;
  }
  throw new Error('JSON writer agent failed validation twice: ' + lastProblems.join('; '));
}

// Runs the full three-agent pipeline. `emit` (optional) receives one progress
// object per agent transition. Returns { updates, syncedAt }.
async function runSync({ tavilyKey, openrouterKey, model, emit }) {
  const send = emit || (() => {});

  send({ agent: 'fetcher', status: 'running' });
  const fetched = await agentFetcher(tavilyKey);
  const c = fetched.counts;
  send({ agent: 'fetcher', status: 'done', detail: `GoComet ${c.gocomet}/9 · Portcast ${c.portcast}/9 · ${c.searches} searches` });

  send({ agent: 'analyst', status: 'running' });
  const analysis = await agentAnalyst(openrouterKey, model || DEFAULT_MODEL, fetched);
  send({ agent: 'analyst', status: 'done' });

  send({ agent: 'writer', status: 'running' });
  const updates = await agentWriter(openrouterKey, model || DEFAULT_MODEL, analysis);
  send({ agent: 'writer', status: 'done' });

  // Enforce the provider numbers deterministically — the agents write the
  // prose, but the headline wait (average of both providers when they
  // disagree) and the vessels-waiting count come straight from the scraped data.
  for (const u of updates) {
    if (!u || !u.id) continue;
    const prov = compareProviders(fetched.goComet && fetched.goComet[u.id], fetched.portcast[u.id]);
    if (!prov) continue;
    u.providers = prov;
    if (prov.avgDays !== null) u.waitH = Math.max(1, Math.round(prov.avgDays * 24));
    if (prov.portcast && prov.portcast.vessels !== null) u.vessels = prov.portcast.vessels;
  }

  return { updates, syncedAt: new Date().toISOString() };
}

module.exports = { DEFAULT_MODEL, PORTS, runSync };
