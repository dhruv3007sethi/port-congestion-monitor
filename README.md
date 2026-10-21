# Port Congestion Monitor

A live dashboard tracking congestion at 9 major container ports, with real data
cross-checked from multiple public sources and an embedded live AIS map.

**Ports tracked:** Singapore (SGSIN), Houston (USHOU), Mundra (INMUN),
Rotterdam (NLRTM), Nhava Sheva (INNSA), Jeddah (SAJED), Jebel Ali (AEJEA),
Busan (KRPUS), Kawasaki (JPKWS).

## How it works

Clicking **⟳ Sync live data** runs a three-agent pipeline
([site/lib/pipeline.js](site/lib/pipeline.js)):

1. **Fetcher** — pure I/O, no LLM. Gathers, in parallel:
   - **GoComet** ([real-time tracker](https://www.gocomet.com/real-time-port-congestion)) —
     current vessel delay and weekly/fortnightly/monthly medians for ~500 ports,
     parsed from the page's embedded `__NEXT_DATA__` JSON.
   - **Portcast** (per-port pages, e.g. [/port-congestion/rotterdam](https://www.portcast.io/port-congestion/rotterdam)) —
     weekly median waiting time, congestion category and week-over-week change,
     parsed from the pages' schema.org Dataset JSON-LD.
   - **Tavily** search snippets scoped to those two domains for qualitative context.
2. **Analyst** — an LLM pass (via OpenRouter) that cross-checks the providers and
   writes plain-text notes per port: level, trend, confidence, summary, data-quality
   verdict and cited sources.
3. **JSON Writer** — a second LLM pass that converts the notes into the strict JSON
   schema the frontend consumes, validated with one retry on schema problems.

The pipeline's numbers are then **enforced deterministically in code** — the agents
write the prose, but the headline figures come straight from the scraped data:

- **Waiting time** = GoComet's vessel delay averaged with Portcast's median wait when
  they disagree (they measure different things, so they usually do); both figures and
  whether they agree are shown in small print and in each port's data-quality note.
- **Vessels waiting** = Portcast's average vessels waiting per day at anchorage.

Sync progress streams to the UI as NDJSON, so you can watch each agent run.
The map view embeds VesselFinder's live AIS map centered on the selected port,
showing every vessel in the port area.

## Running locally

```bash
cd site
cp .env.example .env   # then fill in your keys
node server.js         # http://localhost:8080
```

Requires Node 18+ (uses global `fetch`). Two keys are needed for live sync
(the dashboard renders demo data without them):

- `TAVILY_API_KEY` — [tavily.com](https://tavily.com)
- `OPENROUTER_API_KEY` — [openrouter.ai](https://openrouter.ai)
- `OPENROUTER_MODEL` (optional) — defaults to `google/gemini-3-flash-preview`

## Deploying on Vercel

The same code deploys as static files + serverless functions
([site/api/](site/api/), shared logic in [site/lib/](site/lib/)):

1. Import the repo; set **Root Directory** to `site`.
2. Add `TAVILY_API_KEY` and `OPENROUTER_API_KEY` as environment variables.
3. Deploy. [site/vercel.json](site/vercel.json) gives the sync function a
   60-second limit (a sync takes ~30 s).

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/status` | Which keys are configured, and the default model. |
| `POST /api/sync` | Runs the 3-agent pipeline; streams NDJSON progress lines, ending with `{done, updates, syncedAt}`. Body: `{"model": "..."}` (optional). |
| `GET /api/ships?q=<name>&lat=&lon=` | Ship name search (VesselFinder), filtered to ~250 km of the given point when coordinates are passed. Currently not used by the UI. |

## Caveats

- **Scraping-based**: GoComet/Portcast data is parsed from their public
  pages, not official APIs. If a page layout changes, the fetcher degrades gracefully
  (the sync continues with the remaining providers) and the error names the culprit.
- **Provider divergence is systematic**: GoComet reports total vessel delay while
  Portcast reports median anchorage wait, so GoComet always runs higher. The dashboard
  discloses both rather than pretending one number is the truth.
- **VesselFinder is map-only**: it stopped publishing ships-in-port counts on its public
  port pages (now paywalled), so it is used only for the embedded live AIS map.
- Berth utilization is an LLM estimate (no public source), flagged as such in each
  port's data-quality note.
