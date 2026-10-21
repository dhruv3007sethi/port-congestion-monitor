(function () {
  'use strict';

  const ACCENT = '#0e7490';
  const SHOW_JSON = true;
  const DEFAULT_VIEW = 'map';

  const state = { selectedId: 'SGSIN', view: null };

  const LS_KEY = 'pcm_settings_v1';
  const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function persistSettings() {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  }

  const settings = Object.assign({ model: DEFAULT_MODEL }, loadSettings());
  const sync = { status: 'idle', error: null, lastSyncAt: null };
  const liveOverrides = {};
  let settingsOpen = false;
  const serverStatus = { checked: false, tavilyConfigured: false, openrouterConfigured: false };

  function relativeTime(iso) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    return Math.round(mins / 60) + 'h ago';
  }

  function sanitizeOverride(base, override) {
    if (!override || typeof override !== 'object') return null;
    const p = { ...override };
    // Clamp to plausible ranges — an LLM occasionally misreads an unrelated
    // number (a TEU count, a year, etc.) as the metric itself, and an
    // unbounded value here breaks layout (e.g. a marker sized off vessels).
    p.vessels = Number.isFinite(+p.vessels) ? Math.min(5000, Math.max(0, Math.round(+p.vessels))) : base.vessels;
    p.waitH = Number.isFinite(+p.waitH) ? Math.min(500, Math.max(0, Math.round(+p.waitH))) : base.waitH;
    p.berth = Number.isFinite(+p.berth) ? Math.min(100, Math.max(0, Math.round(+p.berth))) : base.berth;
    if (!LEVELS_VALID.has(p.level)) p.level = base.level;
    if (!TRENDS_VALID.has(p.trend)) p.trend = base.trend;
    if (!CONF_VALID.has(p.conf)) p.conf = base.conf;
    if (typeof p.summary !== 'string' || !p.summary.trim()) p.summary = base.summary;
    if (typeof p.dataQuality !== 'string' || !p.dataQuality.trim()) p.dataQuality = base.dataQuality;
    if (!Array.isArray(p.sources) || !p.sources.length) p.sources = base.sources;
    else p.sources = p.sources.slice(0, 3).map(s => ({
      title: typeof s.title === 'string' ? s.title : 'Untitled source',
      outlet: typeof s.outlet === 'string' ? s.outlet : '',
      date: typeof s.date === 'string' ? s.date : '',
      signal: typeof s.signal === 'string' ? s.signal : '',
      url: typeof s.url === 'string' && /^https?:\/\//i.test(s.url) ? s.url : ''
    }));
    return p;
  }

  const LEVELS = {
    low:      { label: 'Low',      dot: '#22c55e', color: '#15803d', bg: '#dcfce7', halo: 'rgba(34,197,94,0.18)',  rank: 1, header: '#15803d' },
    moderate: { label: 'Moderate', dot: '#eab308', color: '#a16207', bg: '#fef9c3', halo: 'rgba(234,179,8,0.18)',  rank: 2, header: '#a16207' },
    high:     { label: 'High',     dot: '#f97316', color: '#c2410c', bg: '#ffedd5', halo: 'rgba(249,115,22,0.18)', rank: 3, header: '#c2410c' },
    severe:   { label: 'Severe',   dot: '#ef4444', color: '#b91c1c', bg: '#fee2e2', halo: 'rgba(239,68,68,0.20)',  rank: 4, header: '#b91c1c' }
  };
  const TRENDS = {
    improving: { label: 'Improving', arrow: '▼', color: '#15803d' },
    stable:    { label: 'Stable',    arrow: '▬', color: '#64748b' },
    worsening: { label: 'Worsening', arrow: '▲', color: '#dc2626' }
  };
  const CONF = {
    high:   { short: 'High',   color: '#15803d', filled: 3 },
    medium: { short: 'Medium', color: '#a16207', filled: 2 },
    low:    { short: 'Low',    color: '#dc2626', filled: 1 }
  };

  const LEVELS_VALID = new Set(Object.keys(LEVELS));
  const TRENDS_VALID = new Set(Object.keys(TRENDS));
  const CONF_VALID = new Set(Object.keys(CONF));

  const RAW = [
    { id: 'SGSIN', name: 'Singapore', country: 'Singapore', lat: 1.26, lng: 103.84, level: 'severe', vessels: 28, waitH: 90, berth: 96, trend: 'worsening', conf: 'high', updatedText: '8 min ago', iso: '2026-06-29T09:42:00Z',
      summary: 'Severe congestion persists as transshipment volumes surge and vessel bunching from earlier Red Sea diversions works through the system. Berth windows are fully booked into next week.',
      dataQuality: 'Two sources report different waits (72h vs 96h); the dashboard uses the more recent figure. High agreement across sources on direction of travel.',
      sources: [
        { title: 'Singapore anchorage queue swells past 25 boxships', outlet: 'The Loadstar', date: 'Jun 27, 2026', signal: '~28 vessels waiting; 3–4 day berthing delays' },
        { title: 'PSA reports record weekly throughput amid berth crunch', outlet: 'Splash247', date: 'Jun 26, 2026', signal: 'Berth utilization > 95%' },
        { title: 'Carriers warn of worsening Singapore turnaround', outlet: "Lloyd's List", date: 'Jun 25, 2026', signal: 'Turnaround times trending up' }
      ] },
    { id: 'USHOU', name: 'Houston', country: 'United States', lat: 29.73, lng: -95.27, level: 'high', vessels: 19, waitH: 54, berth: 91, trend: 'worsening', conf: 'high', updatedText: '22 min ago', iso: '2026-06-29T09:28:00Z',
      summary: 'Fog-related channel closures earlier this month created a vessel backlog that is still clearing. Import volumes remain elevated heading into peak season.',
      dataQuality: 'Vessel count corroborated by two sources. Wait time converted from qualitative "multi-day" descriptions to an hours estimate.',
      sources: [
        { title: 'Houston ship channel backlog grows after fog delays', outlet: 'gCaptain', date: 'Jun 28, 2026', signal: '~19 vessels queued' },
        { title: 'Gulf ports brace for peak-season import surge', outlet: 'Container News', date: 'Jun 24, 2026', signal: 'Berth utilization ~90%' }
      ] },
    { id: 'INMUN', name: 'Mundra', country: 'India', lat: 22.74, lng: 69.70, level: 'high', vessels: 14, waitH: 46, berth: 88, trend: 'stable', conf: 'medium', updatedText: '1h ago', iso: '2026-06-29T08:50:00Z',
      summary: "Sustained high utilization at India's largest private port. Yard density is elevated but berth productivity is holding steady.",
      dataQuality: 'Single primary source for vessel count, cross-checked against a port circular. Medium confidence pending corroboration.',
      sources: [
        { title: 'Mundra handling near capacity as volumes climb', outlet: 'Maritime Gazette', date: 'Jun 26, 2026', signal: '~14 vessels at anchorage' },
        { title: 'APSEZ flags elevated yard utilization at Mundra', outlet: 'Container News', date: 'Jun 23, 2026', signal: 'Yard density high; berth productivity stable' }
      ] },
    { id: 'NLRTM', name: 'Rotterdam', country: 'Netherlands', lat: 51.95, lng: 4.14, level: 'moderate', vessels: 11, waitH: 32, berth: 84, trend: 'stable', conf: 'high', updatedText: '18 min ago', iso: '2026-06-29T09:32:00Z',
      summary: 'Barge and inland-waterway constraints are contributing to deepsea berth waits. Overall operations are stable but being watched closely.',
      dataQuality: 'Strong source coverage; reported figures are consistent across outlets.',
      sources: [
        { title: 'Rotterdam barge delays ripple into deepsea berths', outlet: 'Splash247', date: 'Jun 28, 2026', signal: '~11 vessels waiting' },
        { title: 'Low-water risk monitored on Rhine corridor', outlet: "Lloyd's List", date: 'Jun 24, 2026', signal: 'Inland-waterway constraints' }
      ] },
    { id: 'INNSA', name: 'Nhava Sheva', country: 'India', lat: 18.95, lng: 72.95, level: 'moderate', vessels: 9, waitH: 28, berth: 82, trend: 'improving', conf: 'high', updatedText: '35 min ago', iso: '2026-06-29T09:15:00Z',
      summary: 'Congestion easing after a busy stretch; additional rail evacuation is reducing dwell. Anchorage queue is down week-on-week.',
      dataQuality: 'Consistent figures across two sources; the improving trend is well supported.',
      sources: [
        { title: 'JNPT clears backlog as rail evacuation ramps up', outlet: 'The Loadstar', date: 'Jun 27, 2026', signal: 'Queue down to ~9 vessels' },
        { title: 'Nhava Sheva dwell times fall in June', outlet: 'Maritime Gazette', date: 'Jun 25, 2026', signal: 'Dwell improving' }
      ] },
    { id: 'SAJED', name: 'Jeddah', country: 'Saudi Arabia', lat: 21.48, lng: 39.16, level: 'moderate', vessels: 8, waitH: 24, berth: 79, trend: 'worsening', conf: 'medium', updatedText: '2h ago', iso: '2026-06-29T07:50:00Z',
      summary: 'Red Sea routing shifts are adding calls and waits are creeping up. Terminal works are limiting the number of available berths.',
      dataQuality: 'Partial data — vessel count estimated from one report; wait time is qualitative ("rising"). Medium confidence.',
      sources: [
        { title: 'Jeddah Islamic Port sees rising calls amid Red Sea shifts', outlet: 'Hellenic Shipping News', date: 'Jun 26, 2026', signal: '~8 vessels; waits rising' },
        { title: 'Terminal upgrade works reduce Jeddah berth availability', outlet: 'Seatrade', date: 'Jun 22, 2026', signal: 'Fewer berths available' }
      ] },
    { id: 'AEJEA', name: 'Jebel Ali', country: 'United Arab Emirates', lat: 25.01, lng: 55.06, level: 'moderate', vessels: 7, waitH: 20, berth: 77, trend: 'improving', conf: 'high', updatedText: '40 min ago', iso: '2026-06-29T09:10:00Z',
      summary: 'Operations normalizing after the seasonal peak; ample berth capacity is keeping waits contained.',
      dataQuality: 'Good source agreement; the improving trend is supported.',
      sources: [
        { title: 'Jebel Ali throughput steady as waits ease', outlet: 'TradeWinds', date: 'Jun 27, 2026', signal: '~7 vessels; waits easing' },
        { title: 'DP World reports smooth Jebel Ali operations', outlet: 'Container News', date: 'Jun 25, 2026', signal: 'Berth capacity adequate' }
      ] },
    { id: 'KRPUS', name: 'Busan', country: 'South Korea', lat: 35.10, lng: 129.04, level: 'low', vessels: 5, waitH: 12, berth: 71, trend: 'stable', conf: 'high', updatedText: '27 min ago', iso: '2026-06-29T09:23:00Z',
      summary: 'Fluid operations with minimal waiting. Transshipment volumes are healthy without congestion pressure.',
      dataQuality: 'Well covered; figures are consistent and current.',
      sources: [
        { title: 'Busan stays fluid as transshipment holds steady', outlet: 'Splash247', date: 'Jun 28, 2026', signal: '~5 vessels; minimal waits' }
      ] },
    { id: 'JPKWS', name: 'Kawasaki', country: 'Japan', lat: 35.51, lng: 139.71, level: 'low', vessels: 3, waitH: 7, berth: 64, trend: 'improving', conf: 'low', updatedText: '5h ago', iso: '2026-06-29T04:45:00Z',
      summary: 'Limited recent reporting; available signals indicate light activity and no notable congestion in Tokyo Bay.',
      dataQuality: 'Only qualitative mentions found — no published vessel counts. Figures are best-effort estimates; low confidence.',
      sources: [
        { title: 'Tokyo Bay ports report routine operations', outlet: 'Seatrade', date: 'Jun 21, 2026', signal: 'No congestion noted (qualitative)' }
      ] }
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function waitText(h) {
    if (h < 24) return h + 'h';
    const d = Math.floor(h / 24), r = h % 24;
    return r ? (d + 'd ' + r + 'h') : (d + 'd');
  }

  // Small-print provider breakdown, e.g. "avg of GoComet 2d · Portcast 3h".
  // short=true abbreviates outlets to GC/PC for narrow columns.
  function provPair(p, short) {
    const prov = p.providers && typeof p.providers === 'object' ? p.providers : null;
    if (!prov || (!prov.gocomet && !prov.portcast)) return '';
    const gcName = short ? 'GC' : 'GoComet', pcName = short ? 'PC' : 'Portcast';
    const f = x => waitText(Math.max(1, Math.round(x.days * 24)));
    if (prov.gocomet && prov.portcast) {
      const pair = `${gcName} ${f(prov.gocomet)} · ${pcName} ${f(prov.portcast)}`;
      return prov.agree ? `${pair} (agree)` : `avg of ${pair}`;
    }
    return prov.gocomet ? `${gcName} ${f(prov.gocomet)} only` : `${pcName} ${f(prov.portcast)} only`;
  }

  function confDotsHtml(filled, color) {
    let html = '';
    for (let i = 0; i < 3; i++) {
      const bg = i < filled ? color : '#d4dae1';
      html += `<span style="width:6px;height:6px;border-radius:50%;background:${bg};"></span>`;
    }
    return html;
  }

  function deriveState() {
    const accent = ACCENT;
    const view = state.view || DEFAULT_VIEW;
    const isMap = view === 'map';

    const ports = RAW.map(base => {
      const override = sanitizeOverride(base, liveOverrides[base.id]);
      const p = override ? { ...base, ...override } : base;
      const L = LEVELS[p.level], T = TRENDS[p.trend], C = CONF[p.conf];
      const wt = waitText(p.waitH);
      return {
        ...p, waitText: wt, locode: p.id,
        levelLabel: L.label, dotColor: L.dot, dotHalo: L.halo, levelColor: L.color, rank: L.rank, header: L.header,
        trendArrow: T.arrow, trendLabel: T.label, trendColor: T.color,
        confShort: C.short, confColor: C.color, confFilled: C.filled,
        sourceCount: p.sources.length
      };
    }).sort((a, b) => b.rank - a.rank || b.vessels - a.vessels);

    const selId = state.selectedId;
    const sel = ports.find(p => p.id === selId) || ports[0];

    const totalVessels = ports.reduce((s, p) => s + p.vessels, 0);
    const elevated = ports.filter(p => p.rank >= 3).length;
    const avgWait = Math.round(ports.reduce((s, p) => s + p.waitH, 0) / ports.length);

    const kpis = [
      { label: 'Ports tracked', value: '9', sub: 'across 6 regions', color: '#0f1b2d' },
      { label: 'Elevated (High +)', value: String(elevated), sub: 'of 9 ports', color: '#c2410c' },
      { label: 'Vessels waiting', value: String(totalVessels), sub: 'across 9 ports, avg per day at anchorage', color: '#0f1b2d' },
      { label: 'Avg waiting time', value: avgWait + 'h', sub: 'across ports', color: '#0f1b2d' },
      { label: 'Articles scanned', value: '64', sub: '17 cited', color: accent }
    ];

    return { accent, showJson: SHOW_JSON, isMap, ports, sel, kpis };
  }

  function renderHeader(d) {
    const hasKeys = serverStatus.tavilyConfigured && serverStatus.openrouterConfigured;
    const syncing = sync.status === 'syncing';
    const syncLabel = sync.lastSyncAt
      ? `Last sync <strong style="color:#0f1b2d;font-weight:600;">${relativeTime(sync.lastSyncAt)}</strong>`
      : `<strong style="color:#0f1b2d;font-weight:600;">Demo data</strong> — sync for live info`;

    const syncBtnText = syncing ? 'Syncing…' : (hasKeys ? '⟳ Sync live data' : '⟳ Set up live data');
    const syncBtnStyle = `border:none;cursor:${syncing ? 'default' : 'pointer'};font-family:'Public Sans',sans-serif;font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;background:${syncing ? '#c7ced7' : d.accent};color:#fff;`;

    const errorBanner = sync.status === 'error'
      ? `<div style="margin-top:10px;font-size:12.5px;color:#b91c1c;background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;display:inline-block;">Sync failed: ${esc(sync.error || 'unknown error')}</div>`
      : '';

    const agentBar = syncing && sync.stages ? `
      <div style="margin-top:10px;display:inline-flex;align-items:center;gap:9px;font-size:12px;background:#fff;border:1px solid #dde2e8;border-radius:8px;padding:7px 12px;">
        ${AGENTS.map((a, i) => {
          const st = sync.stages[a.id];
          const icon = st === 'done' ? '✓' : (st === 'running' ? '⟳' : '·');
          const color = st === 'done' ? '#15803d' : (st === 'running' ? d.accent : '#9aa3ae');
          return `${i ? '<span style="color:#cfd5dc;">→</span>' : ''}<span style="color:${color};font-weight:600;white-space:nowrap;">${icon} ${a.label}</span>`;
        }).join('')}
        ${sync.stageDetail ? `<span style="color:#9aa3ae;font-size:11px;">${esc(sync.stageDetail)}</span>` : ''}
      </div>` : '';

    return `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;margin-bottom:20px;">
      <div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:2.5px;color:${d.accent};font-weight:600;margin-bottom:8px;">MARITIME OPS · AI-AGGREGATED SIGNALS</div>
        <h1 style="font-family:'Schibsted Grotesk',sans-serif;font-weight:700;font-size:30px;letter-spacing:-0.6px;margin:0 0 8px;line-height:1;">Port Congestion Monitor</h1>
        <div style="display:flex;align-items:center;gap:14px;font-size:13px;color:#5b6675;flex-wrap:wrap;">
          <span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:50%;background:#16a34a;animation:liveBlink 1.8s infinite;"></span>Live</span>
          <span style="color:#aeb6c0;">·</span>
          <span>${syncLabel}</span>
          <span style="color:#aeb6c0;">·</span>
          <span>9 ports tracked</span>
          <span style="display:inline-flex;gap:6px;margin-left:4px;">
            <span style="font-family:'JetBrains Mono',monospace;font-size:11px;background:#fff;border:1px solid #dde2e8;border-radius:5px;padding:2px 7px;color:#5b6675;">GoComet</span>
            <span style="font-family:'JetBrains Mono',monospace;font-size:11px;background:#fff;border:1px solid #dde2e8;border-radius:5px;padding:2px 7px;color:#5b6675;">Portcast</span>
            <span style="font-family:'JetBrains Mono',monospace;font-size:11px;background:#fff;border:1px solid #dde2e8;border-radius:5px;padding:2px 7px;color:#5b6675;">VesselFinder</span>
            <span style="font-family:'JetBrains Mono',monospace;font-size:11px;background:#fff;border:1px solid #dde2e8;border-radius:5px;padding:2px 7px;color:#5b6675;">${esc(settings.model || DEFAULT_MODEL)}</span>
          </span>
        </div>
        ${errorBanner}
        ${agentBar}
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <button id="syncBtn" ${syncing ? 'disabled' : ''} style="${syncBtnStyle}">${syncBtnText}</button>
        <button id="settingsBtn" title="Live data settings" style="border:1px solid #dde2e8;background:#fff;color:#5b6675;width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:15px;">⚙</button>
        <div style="display:flex;background:#fff;border:1px solid #dde2e8;border-radius:9px;padding:3px;">
          <button data-view="map" class="tab-btn ${d.isMap ? 'active' : ''}" style="${d.isMap ? 'background:' + d.accent + ';' : ''}">Map</button>
          <button data-view="board" class="tab-btn ${!d.isMap ? 'active' : ''}" style="${!d.isMap ? 'background:' + d.accent + ';' : ''}">Board</button>
        </div>
      </div>
    </div>`;
  }

  function renderSettingsModal() {
    if (!settingsOpen) return '';

    const statusRow = (label, ok) => `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid #f2f4f7;">
        <span style="width:8px;height:8px;border-radius:50%;background:${ok ? '#22c55e' : '#d4dae1'};flex:none;"></span>
        <span style="font-size:13px;color:#3d4757;flex:1;">${label}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;color:${ok ? '#15803d' : '#9aa3ae'};">${ok ? 'CONFIGURED' : 'NOT SET'}</span>
      </div>`;

    return `
    <div id="settingsOverlay" style="position:fixed;inset:0;background:rgba(15,27,45,0.45);z-index:1000;display:flex;align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:14px;padding:24px;width:460px;max-width:90vw;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:'Public Sans',sans-serif;">
        <div style="font-family:'Schibsted Grotesk',sans-serif;font-weight:700;font-size:18px;margin-bottom:4px;">Live data settings</div>
        <div style="font-size:12.5px;color:#7a8593;margin-bottom:14px;line-height:1.5;">
          API keys are read from a <code style="background:#f6f8fa;padding:1px 5px;border-radius:4px;">.env</code> file next to <code style="background:#f6f8fa;padding:1px 5px;border-radius:4px;">server.js</code> — not typed into the browser. Each sync runs a 3-agent pipeline: a <strong>fetcher</strong> gathers GoComet's live tracker, 9 Portcast port pages, 9 VesselFinder AIS pages and 9 Tavily searches; an <strong>analyst</strong> LLM cross-checks the providers (averaging wait times when they disagree) and writes per-port notes; a <strong>JSON writer</strong> LLM converts the notes into the dashboard's schema (2 OpenRouter calls total).
        </div>
        <div style="margin-bottom:16px;">
          ${statusRow('TAVILY_API_KEY', serverStatus.tavilyConfigured)}
          ${statusRow('OPENROUTER_API_KEY', serverStatus.openrouterConfigured)}
        </div>
        ${(!serverStatus.tavilyConfigured || !serverStatus.openrouterConfigured) ? `
        <div style="background:#f6f8fa;border:1px solid #eef1f4;border-radius:9px;padding:11px 13px;margin-bottom:16px;font-size:12px;color:#3d4757;line-height:1.6;">
          <div style="font-weight:600;margin-bottom:4px;">To set up:</div>
          1. Copy <code style="background:#fff;border:1px solid #eef1f4;padding:1px 5px;border-radius:4px;">.env.example</code> to <code style="background:#fff;border:1px solid #eef1f4;padding:1px 5px;border-radius:4px;">.env</code> in the site folder<br>
          2. Fill in <code style="background:#fff;border:1px solid #eef1f4;padding:1px 5px;border-radius:4px;">TAVILY_API_KEY</code> and <code style="background:#fff;border:1px solid #eef1f4;padding:1px 5px;border-radius:4px;">OPENROUTER_API_KEY</code><br>
          3. Restart the server: <code style="background:#fff;border:1px solid #eef1f4;padding:1px 5px;border-radius:4px;">node server.js</code>
        </div>` : ''}
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;">OpenRouter model override (optional)</label>
        <input id="modelInput" type="text" value="${esc(settings.model || DEFAULT_MODEL)}" placeholder="${esc(serverStatus.model || DEFAULT_MODEL)}" style="width:100%;padding:9px 11px;border:1px solid #dde2e8;border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:12.5px;margin-bottom:18px;">
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button id="cancelSettingsBtn" style="border:1px solid #dde2e8;background:#fff;color:#5b6675;font-weight:600;font-size:13px;padding:8px 16px;border-radius:8px;cursor:pointer;">Close</button>
          <button id="saveSettingsBtn" style="border:none;background:${ACCENT};color:#fff;font-weight:600;font-size:13px;padding:8px 16px;border-radius:8px;cursor:pointer;">Save</button>
        </div>
      </div>
    </div>`;
  }

  function renderKpis(d) {
    const cards = d.kpis.map(k => `
      <div style="background:#fff;border:1px solid #e4e8ed;border-radius:12px;padding:16px 18px;">
        <div style="font-size:12px;color:#7a8593;font-weight:500;letter-spacing:0.2px;margin-bottom:10px;">${esc(k.label)}</div>
        <div style="display:flex;align-items:baseline;gap:7px;">
          <div style="font-family:'Schibsted Grotesk',sans-serif;font-weight:700;font-size:30px;letter-spacing:-0.5px;line-height:1;color:${k.color};">${esc(k.value)}</div>
          <div style="font-size:12px;color:#9aa3ae;font-weight:500;">${esc(k.sub)}</div>
        </div>
      </div>`).join('');
    return `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:20px;">${cards}</div>`;
  }

  function renderRankedList(d) {
    const rows = d.ports.map(p => {
      const selected = p.id === d.sel.id;
      const rowStyle = `padding:13px 18px;cursor:pointer;border-bottom:1px solid #f2f4f7;border-left:3px solid ${selected ? p.dotColor : 'transparent'};background:${selected ? '#f7fafc' : '#fff'};transition:background .12s;`;
      const badge = `display:inline-block;font-weight:600;font-size:11px;padding:3px 9px;border-radius:20px;background:${p.dotColor === '#22c55e' ? LEVELS.low.bg : ''};white-space:nowrap;`;
      const L = LEVELS[p.level];
      return `
      <div class="port-row" data-port="${p.id}" style="${rowStyle}">
        <div style="display:flex;align-items:center;gap:11px;">
          <span style="width:9px;height:9px;border-radius:50%;background:${p.dotColor};flex:none;box-shadow:0 0 0 3px ${p.dotHalo};"></span>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-weight:600;font-size:14px;">${esc(p.name)}</span>
              <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#9aa3ae;">${esc(p.locode)}</span>
            </div>
            <div style="font-size:11.5px;color:#7a8593;margin-top:3px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span>${p.vessels} ships</span><span style="color:#cfd5dc;">·</span>
              <span>${esc(p.waitText)} wait</span><span style="color:#cfd5dc;">·</span>
              <span style="color:${p.trendColor};font-weight:600;">${p.trendArrow} ${esc(p.trendLabel)}</span>
            </div>
            ${provPair(p) ? `<div style="font-size:10px;color:#9aa3ae;margin-top:3px;">${esc(provPair(p))}</div>` : ''}
          </div>
          <span style="display:inline-block;font-weight:600;font-size:11px;padding:3px 9px;border-radius:20px;background:${L.bg};color:${L.color};white-space:nowrap;">${esc(p.levelLabel)}</span>
        </div>
      </div>`;
    }).join('');

    return `
    <div style="background:#fff;border:1px solid #e4e8ed;border-radius:14px;overflow:hidden;">
      <div style="padding:15px 18px 12px;border-bottom:1px solid #eef1f4;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-family:'Schibsted Grotesk',sans-serif;font-weight:600;font-size:14px;">Ports by congestion</span>
        <span style="font-size:11px;color:#9aa3ae;font-family:'JetBrains Mono',monospace;">SORTED ↓</span>
      </div>
      <div>${rows}</div>
    </div>`;
  }

  function renderMap(d) {
    const sel = d.sel;

    // Exact URL VesselFinder's official aismap.js embed generates — all ships
    // in the port area, centered on the port at zoom 8. store_pos=false is
    // deliberate: the embed otherwise restores its last stored map position
    // and ignores our center, so switching ports wouldn't move the map.
    const src = `https://www.vesselfinder.com/aismap?zoom=8&lat=${sel.lat}&lon=${sel.lng}`
      + '&width=100%25&height=460&names=false&track=false&fleet=false&fleet_name=false'
      + '&fleet_hide_old_positions=false&clicktoact=false&store_pos=false'
      + '&ra=' + encodeURIComponent(location.href);

    return `
      <div style="padding:15px 18px 12px;border-bottom:1px solid #eef1f4;display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <span style="font-family:'Schibsted Grotesk',sans-serif;font-weight:600;font-size:14px;">All ships around ${esc(sel.name)}</span>
        <span style="font-size:11px;color:#9aa3ae;font-family:'JetBrains Mono',monospace;">VESSELFINDER</span>
      </div>
      <div style="height:460px;margin:13px 16px 0;border-radius:10px;overflow:hidden;border:1px solid #e1e7ee;background:#e7eef4;">
        <iframe title="VesselFinder live AIS map — ${esc(sel.name)}" width="100%" height="460" frameborder="0" style="border:0;display:block;" src="${src}"></iframe>
      </div>
      <div style="padding:10px 18px 16px;font-size:11px;color:#9aa3ae;font-family:'JetBrains Mono',monospace;">Live vessel positions © VesselFinder · click a port to see all ships in its area</div>`;
  }

  function renderBoard(d) {
    const headerCols = '<span>Port</span><span>Level</span><span style="text-align:right;">Ships</span><span style="text-align:right;">Avg wait</span><span style="text-align:right;">Berth</span><span>Trend</span><span>Confidence</span>';
    const rows = d.ports.map(p => {
      const selected = p.id === d.sel.id;
      const tableRowStyle = `display:grid;grid-template-columns:1.6fr 0.9fr 0.7fr 0.8fr 0.7fr 0.9fr 1fr;align-items:center;padding:12px 18px;cursor:pointer;border-bottom:1px solid #f2f4f7;background:${selected ? '#f7fafc' : '#fff'};border-left:3px solid ${selected ? p.dotColor : 'transparent'};`;
      const L = LEVELS[p.level];
      return `
      <div class="board-row" data-port="${p.id}" style="${tableRowStyle}">
        <span style="display:flex;flex-direction:column;"><span style="font-weight:600;font-size:13.5px;">${esc(p.name)}</span><span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#9aa3ae;">${esc(p.locode)} · ${esc(p.country)}</span></span>
        <span><span style="display:inline-block;font-weight:600;font-size:11px;padding:3px 9px;border-radius:20px;background:${L.bg};color:${L.color};white-space:nowrap;">${esc(p.levelLabel)}</span></span>
        <span style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:500;">${p.vessels}</span>
        <span style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;"><span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:500;">${esc(p.waitText)}</span>${provPair(p, true) ? `<span style="font-size:9.5px;color:#9aa3ae;margin-top:2px;white-space:nowrap;">${esc(provPair(p, true))}</span>` : ''}</span>
        <span style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:500;">${p.berth}%</span>
        <span style="color:${p.trendColor};font-weight:600;font-size:12.5px;">${p.trendArrow} ${esc(p.trendLabel)}</span>
        <span style="display:inline-flex;align-items:center;gap:5px;"><span style="display:inline-flex;gap:2px;">${confDotsHtml(p.confFilled, p.confColor)}</span><span style="font-size:11.5px;color:#7a8593;">${esc(p.confShort)}</span></span>
      </div>`;
    }).join('');

    return `
      <div style="padding:15px 18px 12px;border-bottom:1px solid #eef1f4;font-family:'Schibsted Grotesk',sans-serif;font-weight:600;font-size:14px;">Normalized signal board</div>
      <div style="display:grid;grid-template-columns:1.6fr 0.9fr 0.7fr 0.8fr 0.7fr 0.9fr 1fr;gap:6px;padding:11px 18px;font-size:11px;color:#9aa3ae;font-weight:600;letter-spacing:0.3px;border-bottom:1px solid #eef1f4;text-transform:uppercase;">${headerCols}</div>
      ${rows}`;
  }

  function renderDetail(d) {
    const sel = d.sel;
    const L = LEVELS[sel.level];
    const prov = sel.providers && typeof sel.providers === 'object' ? sel.providers : null;
    const provDays = days => waitText(Math.max(1, Math.round(days * 24)));
    let provNote = '';
    if (prov && prov.gocomet && prov.portcast) {
      const gc = `GoComet ${provDays(prov.gocomet.days)}${prov.gocomet.level ? ' (' + prov.gocomet.level + ')' : ''}`;
      const pc = `Portcast ${provDays(prov.portcast.days)}${prov.portcast.level ? ' (' + prov.portcast.level + ')' : ''}`;
      provNote = `<div style="font-size:10px;color:#9aa3ae;margin-top:6px;line-height:1.45;">${prov.agree ? 'sources agree' : 'average of'} — ${esc(gc)} · ${esc(pc)}</div>`;
    } else if (prov && (prov.gocomet || prov.portcast)) {
      provNote = `<div style="font-size:10px;color:#9aa3ae;margin-top:6px;">${prov.gocomet ? 'GoComet' : 'Portcast'} data only</div>`;
    }
    const vesselNote = prov && prov.portcast && prov.portcast.vessels !== null
      ? `<div style="font-size:10px;color:#9aa3ae;margin-top:6px;">per Portcast, avg per day at anchorage</div>` : '';
    const headerStyle = `padding:18px;background:${L.header};`;
    const berthBarStyle = `height:100%;width:${sel.berth}%;background:${sel.dotColor};border-radius:5px;`;
    const dqStyle = `background:#f6f8fa;border:1px solid #eef1f4;border-left:3px solid ${sel.dotColor};border-radius:9px;padding:11px 13px;`;

    const jsonText = JSON.stringify({
      port: sel.name, locode: sel.locode, country: sel.country,
      coordinates: { lat: sel.lat, lng: sel.lng },
      congestion_level: sel.level,
      vessels_waiting: sel.vessels,
      avg_waiting_time_hours: sel.waitH,
      ...(prov ? { wait_days_by_source: {
        gocomet: prov.gocomet ? prov.gocomet.days : null,
        portcast: prov.portcast ? prov.portcast.days : null,
        average: prov.avgDays,
        sources_agree: prov.agree
      } } : {}),
      berth_utilization_pct: sel.berth,
      delay_trend: sel.trend,
      confidence: sel.conf,
      last_updated: sel.iso,
      sources_count: sel.sources.length,
      data_quality_note: sel.dataQuality
    }, null, 2);

    const sources = sel.sources.map(s => {
      const inner = `
        <div style="font-size:13px;font-weight:600;line-height:1.35;color:#0f1b2d;">${esc(s.title)}${s.url ? ` <span style="color:${d.accent};font-size:11px;">↗</span>` : ''}</div>
        <div style="font-size:11px;color:#9aa3ae;margin-top:3px;display:flex;gap:7px;"><span style="color:${d.accent};font-weight:600;">${esc(s.outlet)}</span><span>·</span><span>${esc(s.date)}</span></div>
        <div style="font-size:11.5px;color:#5b6675;margin-top:7px;font-family:'JetBrains Mono',monospace;background:#f6f8fa;border-radius:6px;padding:5px 8px;">↳ ${esc(s.signal)}</div>`;
      return s.url
        ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="source-link" title="${esc(s.url)}" style="display:block;text-decoration:none;border:1px solid #eef1f4;border-radius:9px;padding:10px 12px;transition:border-color .12s,background .12s;">${inner}</a>`
        : `<div style="border:1px solid #eef1f4;border-radius:9px;padding:10px 12px;">${inner}</div>`;
    }).join('');

    const jsonBlock = d.showJson ? `
      <div style="margin-top:18px;">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#7a8593;margin-bottom:9px;">Normalized output</div>
        <pre style="margin:0;background:#0f1b2d;color:#cde3ee;border-radius:10px;padding:14px 15px;font-family:'JetBrains Mono',monospace;font-size:11.5px;line-height:1.55;overflow-x:auto;">${esc(jsonText)}</pre>
      </div>` : '';

    return `
    <div style="background:#fff;border:1px solid #e4e8ed;border-radius:14px;overflow:hidden;">
      <div style="${headerStyle}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div>
            <div style="font-family:'Schibsted Grotesk',sans-serif;font-weight:700;font-size:21px;letter-spacing:-0.3px;color:#fff;">${esc(sel.name)}</div>
            <div style="font-size:12.5px;color:rgba(255,255,255,0.78);margin-top:3px;font-family:'JetBrains Mono',monospace;">${esc(sel.locode)} · ${esc(sel.country)}</div>
          </div>
          <span style="background:rgba(255,255,255,0.18);color:#fff;font-weight:600;font-size:12px;padding:5px 11px;border-radius:20px;border:1px solid rgba(255,255,255,0.25);">${esc(sel.levelLabel)}</span>
        </div>
        <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:12px;display:flex;align-items:center;gap:8px;">Updated ${esc(sel.updatedText)} · ${sel.sourceCount} sources</div>
      </div>

      <div style="padding:18px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:16px;">
          <div style="border:1px solid #eef1f4;border-radius:10px;padding:12px 13px;">
            <div style="font-size:11px;color:#7a8593;margin-bottom:6px;">Vessels waiting</div>
            <div style="font-family:'Schibsted Grotesk',sans-serif;font-weight:700;font-size:24px;line-height:1;">${sel.vessels}</div>
            ${vesselNote}
          </div>
          <div style="border:1px solid #eef1f4;border-radius:10px;padding:12px 13px;">
            <div style="font-size:11px;color:#7a8593;margin-bottom:6px;">Avg waiting time</div>
            <div style="font-family:'Schibsted Grotesk',sans-serif;font-weight:700;font-size:24px;line-height:1;">${esc(sel.waitText)}</div>
            ${provNote}
          </div>
        </div>

        <div style="border:1px solid #eef1f4;border-radius:10px;padding:12px 13px;margin-bottom:11px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px;">
            <span style="font-size:11px;color:#7a8593;">Berth utilization</span>
            <span style="font-family:'JetBrains Mono',monospace;font-weight:600;font-size:14px;color:${sel.dotColor};">${sel.berth}%</span>
          </div>
          <div style="height:7px;border-radius:5px;background:#eef1f4;overflow:hidden;"><div style="${berthBarStyle}"></div></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:16px;">
          <div style="border:1px solid #eef1f4;border-radius:10px;padding:12px 13px;">
            <div style="font-size:11px;color:#7a8593;margin-bottom:6px;">Delay trend</div>
            <div style="font-weight:600;font-size:14px;color:${sel.trendColor};">${sel.trendArrow} ${esc(sel.trendLabel)}</div>
          </div>
          <div style="border:1px solid #eef1f4;border-radius:10px;padding:12px 13px;">
            <div style="font-size:11px;color:#7a8593;margin-bottom:6px;">Data confidence</div>
            <div style="display:flex;align-items:center;gap:7px;"><span style="display:inline-flex;gap:3px;">${confDotsHtml(sel.confFilled, sel.confColor)}</span><span style="font-weight:600;font-size:13px;color:${sel.confColor};">${esc(sel.confShort)}</span></div>
          </div>
        </div>

        <div style="font-size:13px;line-height:1.55;color:#3d4757;margin-bottom:14px;">${esc(sel.summary)}</div>

        <div style="${dqStyle}">
          <div style="font-size:10.5px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;margin-bottom:5px;color:${sel.levelColor};">Data quality note</div>
          <div style="font-size:12.5px;line-height:1.5;color:#3d4757;">${esc(sel.dataQuality)}</div>
        </div>

        <div style="margin-top:18px;">
          <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#7a8593;margin-bottom:10px;">Source citations</div>
          <div style="display:flex;flex-direction:column;gap:9px;">${sources}</div>
        </div>

        ${jsonBlock}
      </div>
    </div>`;
  }

  async function refreshServerStatus() {
    try {
      const res = await fetch('/api/status');
      const json = await res.json();
      serverStatus.checked = true;
      serverStatus.tavilyConfigured = !!json.tavilyConfigured;
      serverStatus.openrouterConfigured = !!json.openrouterConfigured;
      serverStatus.model = json.model || DEFAULT_MODEL;
    } catch (e) {
      serverStatus.checked = true;
    }
    render();
  }

  const AGENTS = [
    { id: 'fetcher', label: 'Fetcher' },
    { id: 'analyst', label: 'Analyst' },
    { id: 'writer', label: 'JSON Writer' }
  ];

  async function doSync() {
    if (!serverStatus.tavilyConfigured || !serverStatus.openrouterConfigured) {
      settingsOpen = true;
      render();
      return;
    }
    sync.status = 'syncing';
    sync.error = null;
    sync.stages = { fetcher: 'pending', analyst: 'pending', writer: 'pending' };
    sync.stageDetail = null;
    render();
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.model || DEFAULT_MODEL })
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || ('Request failed with status ' + res.status));
      }
      // The server streams NDJSON progress lines, one per agent transition,
      // ending with a {done, updates, syncedAt} line.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', final = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.error) throw new Error(msg.error);
          if (msg.done) { final = msg; continue; }
          if (msg.agent && sync.stages) {
            sync.stages[msg.agent] = msg.status;
            if (msg.detail) sync.stageDetail = msg.detail;
            render();
          }
        }
      }
      if (!final) throw new Error('Sync stream ended unexpectedly');
      (final.updates || []).forEach(u => {
        if (u && u.id) liveOverrides[u.id] = { ...u, updatedText: 'just now', iso: final.syncedAt };
      });
      sync.lastSyncAt = final.syncedAt;
      sync.status = 'idle';
    } catch (e) {
      sync.status = 'error';
      sync.error = e.message || 'Sync failed';
    }
    sync.stages = null;
    sync.stageDetail = null;
    render();
  }

  function render() {
    const d = deriveState();
    const app = document.getElementById('app');
    app.innerHTML = `
      <div style="font-family:'Public Sans',sans-serif;color:#0f1b2d;background:#eef1f4;min-height:100vh;">
        ${renderHeader(d)}
        ${renderKpis(d)}
        <div style="display:grid;grid-template-columns:330px 1fr 388px;gap:18px;align-items:start;">
          ${renderRankedList(d)}
          <div style="background:#fff;border:1px solid #e4e8ed;border-radius:14px;overflow:hidden;">
            ${d.isMap ? renderMap(d) : renderBoard(d)}
          </div>
          ${renderDetail(d)}
        </div>
      </div>
      ${renderSettingsModal()}`;

    app.querySelectorAll('[data-port]').forEach(el => {
      el.addEventListener('click', () => {
        state.selectedId = el.getAttribute('data-port');
        render();
      });
    });
    app.querySelectorAll('[data-view]').forEach(el => {
      el.addEventListener('click', () => {
        state.view = el.getAttribute('data-view');
        render();
      });
    });

    const syncBtn = document.getElementById('syncBtn');
    if (syncBtn) syncBtn.addEventListener('click', doSync);

    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => { settingsOpen = true; render(); });

    const overlay = document.getElementById('settingsOverlay');
    if (overlay) {
      overlay.addEventListener('click', e => { if (e.target === overlay) { settingsOpen = false; render(); } });
      document.getElementById('cancelSettingsBtn').addEventListener('click', () => { settingsOpen = false; render(); });
      document.getElementById('saveSettingsBtn').addEventListener('click', () => {
        settings.model = document.getElementById('modelInput').value.trim() || DEFAULT_MODEL;
        persistSettings();
        settingsOpen = false;
        render();
      });
    }
  }

  render();
  refreshServerStatus();
})();
