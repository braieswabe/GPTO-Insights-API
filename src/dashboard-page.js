const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPTO Insights — Telemetry</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0b0f1a;--surface:#141926;--border:#1e2537;--text:#e2e8f0;--muted:#64748b;
    --accent:#3b82f6;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--radius:10px}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:var(--bg);color:var(--text);line-height:1.5;padding:24px;max-width:1100px;margin:0 auto}
  h1{font-size:1.5rem;font-weight:700;margin-bottom:4px}
  .subtitle{color:var(--muted);font-size:.85rem;margin-bottom:24px}
  .bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:20px}
  .bar label{font-size:.8rem;color:var(--muted)}
  select,input,button{background:var(--surface);color:var(--text);border:1px solid var(--border);
    border-radius:6px;padding:7px 12px;font-size:.85rem;outline:none}
  select:focus,input:focus{border-color:var(--accent)}
  button{cursor:pointer;background:var(--accent);border-color:var(--accent);font-weight:600;
    transition:opacity .15s}
  button:hover{opacity:.85}
  button:disabled{opacity:.4;cursor:default}
  .token-row{display:flex;gap:8px;align-items:center;margin-bottom:20px}
  .token-row input{flex:1;font-family:monospace;font-size:.78rem}
  .status{padding:3px 10px;border-radius:20px;font-size:.75rem;font-weight:600;display:inline-block}
  .status.ok{background:#22c55e22;color:var(--green)}
  .status.err{background:#ef444422;color:var(--red)}
  .status.warn{background:#f59e0b22;color:var(--amber)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:24px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px}
  .card .label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
  .card .value{font-size:1.6rem;font-weight:700}
  .card .trend{font-size:.8rem;margin-top:4px}
  .trend.up{color:var(--green)} .trend.down{color:var(--red)} .trend.flat{color:var(--muted)}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
    padding:20px;margin-bottom:20px}
  .panel h2{font-size:1rem;font-weight:600;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;color:var(--muted);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--border)}
  td{padding:6px 8px;border-bottom:1px solid var(--border)}
  .chart{position:relative;height:220px;display:flex;align-items:flex-end;gap:2px;padding-top:20px}
  .chart-bar{flex:1;background:var(--accent);border-radius:3px 3px 0 0;min-width:4px;position:relative;
    transition:height .3s}
  .chart-bar:hover{opacity:.8}
  .chart-bar .tip{display:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);
    background:#000c;color:#fff;padding:4px 8px;border-radius:4px;font-size:.7rem;white-space:nowrap;margin-bottom:4px}
  .chart-bar:hover .tip{display:block}
  .chart-labels{display:flex;justify-content:space-between;font-size:.7rem;color:var(--muted);margin-top:4px}
  .empty{text-align:center;padding:40px;color:var(--muted)}
  .spinner{display:inline-block;width:18px;height:18px;border:2px solid var(--border);
    border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;margin-right:6px;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  .sites-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px}
  .site-chip{background:var(--surface);border:1px solid var(--border);border-radius:20px;
    padding:4px 14px;font-size:.8rem;cursor:pointer;transition:all .15s}
  .site-chip:hover,.site-chip.active{background:var(--accent);border-color:var(--accent);color:#fff}
  .raw-toggle{font-size:.75rem;color:var(--accent);cursor:pointer;float:right}
  pre.raw{background:#0a0e17;border:1px solid var(--border);border-radius:6px;padding:14px;
    font-size:.75rem;overflow-x:auto;max-height:300px;white-space:pre-wrap;margin-top:10px;display:none}
  pre.raw.show{display:block}
</style>
</head>
<body>

<h1>GPTO Insights Gateway</h1>
<p class="subtitle">Telemetry Data Viewer</p>

<div class="token-row">
  <label style="font-size:.8rem;color:var(--muted);white-space:nowrap">API Token</label>
  <input id="token" type="password" placeholder="Paste your INTERNAL_API_TOKEN here">
  <button id="connectBtn" onclick="connect()">Connect</button>
</div>

<div id="app" style="display:none">
  <div class="bar">
    <div><label>Range</label><br>
      <select id="range" onchange="loadTelemetry()">
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </select>
    </div>
    <div style="margin-left:auto">
      <span id="connStatus"></span>
    </div>
  </div>

  <div id="siteChips" class="sites-list"></div>
  <div id="content"><div class="empty">Select a site above to view telemetry</div></div>
</div>

<script>
const API = window.location.origin;
let TOKEN = '';
let sites = [];
let activeSiteId = null;

function headers() {
  return { 'Authorization': 'Bearer ' + TOKEN, 'x-gpto-user-role': 'admin' };
}

async function apiFetch(path) {
  const res = await fetch(API + path, { headers: headers() });
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
  return res.json();
}

function setStatus(text, type) {
  const el = document.getElementById('connStatus');
  el.innerHTML = '<span class="status ' + type + '">' + text + '</span>';
}

async function connect() {
  TOKEN = document.getElementById('token').value.trim();
  if (!TOKEN) return;
  document.getElementById('connectBtn').disabled = true;
  try {
    const health = await apiFetch('/internal/health');
    if (!health.ok) throw new Error('Health check failed');
    sites = await apiFetch('/v1/sites');
    document.getElementById('app').style.display = 'block';
    setStatus('Connected', 'ok');
    renderSiteChips();
    if (sites.length > 0) { activeSiteId = sites[0].id; highlightChip(); loadTelemetry(); }
    else { document.getElementById('content').innerHTML = '<div class="empty">No sites found</div>'; }
  } catch (e) {
    setStatus('Error: ' + e.message, 'err');
  } finally {
    document.getElementById('connectBtn').disabled = false;
  }
}

function renderSiteChips() {
  const el = document.getElementById('siteChips');
  el.innerHTML = '<div class="site-chip" data-id="" onclick="selectSite(null)">All Sites</div>' +
    sites.map(s => '<div class="site-chip" data-id="' + s.id + '" onclick="selectSite(\\'' + s.id + '\\')">' + esc(s.domain) + '</div>').join('');
  highlightChip();
}

function highlightChip() {
  document.querySelectorAll('.site-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.id === (activeSiteId || ''));
  });
}

function selectSite(id) { activeSiteId = id; highlightChip(); loadTelemetry(); }

async function loadTelemetry() {
  const range = document.getElementById('range').value;
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty"><span class="spinner"></span> Loading telemetry\u2026</div>';
  try {
    const qs = new URLSearchParams({ range, portal: 'employee' });
    if (activeSiteId) qs.set('siteId', activeSiteId);
    const res = await apiFetch('/v1/dashboard/module/telemetry?' + qs);
    const d = res.data || res;
    renderTelemetry(d, res);
  } catch (e) {
    content.innerHTML = '<div class="empty" style="color:var(--red)">Failed: ' + esc(e.message) + '</div>';
  }
}

function fmt(n) {
  if (n == null) return '0';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

function trendHtml(v) {
  if (v == null || v === 0) return '<span class="trend flat">—</span>';
  const pct = (v * 100).toFixed(1);
  if (v > 0) return '<span class="trend up">\u25B2 ' + pct + '%</span>';
  return '<span class="trend down">\u25BC ' + Math.abs(pct) + '%</span>';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function renderTelemetry(d, raw) {
  const t = d.totals || {};
  const tr = d.trend || {};
  const series = d.series || [];
  const topPages = d.topPages || [];
  const topIntents = d.topIntents || [];
  const hasData = series.length > 0;

  let html = '';

  // KPI cards
  html += '<div class="cards">';
  [{l:'Visits',k:'visits'},{l:'Page Views',k:'pageViews'},{l:'Searches',k:'searches'},{l:'Interactions',k:'interactions'}].forEach(m => {
    html += '<div class="card"><div class="label">' + m.l + '</div><div class="value">' + fmt(t[m.k]) + '</div>' + trendHtml(tr[m.k]) + '</div>';
  });
  html += '</div>';

  if (!hasData) {
    html += '<div class="empty">No telemetry data for this range yet.<br><span style="font-size:.8rem;color:var(--muted)">Data appears after the daily rollup runs.</span></div>';
    html += rawSection(raw);
    document.getElementById('content').innerHTML = html;
    return;
  }

  // Chart
  const maxVal = Math.max(...series.map(s => s.visits || 0), 1);
  html += '<div class="panel"><h2>Daily Visits</h2><div class="chart">';
  series.forEach(s => {
    const h = Math.max(((s.visits||0)/maxVal)*190, 2);
    html += '<div class="chart-bar" style="height:' + h + 'px"><div class="tip">' + (s.date||'') + ': ' + fmt(s.visits) + ' visits</div></div>';
  });
  html += '</div><div class="chart-labels"><span>' + (series[0]?.date||'') + '</span><span>' + (series[series.length-1]?.date||'') + '</span></div></div>';

  // Top pages
  if (topPages.length) {
    html += '<div class="panel"><h2>Top Pages</h2><table><thead><tr><th>URL</th><th style="text-align:right">Count</th></tr></thead><tbody>';
    topPages.slice(0,10).forEach(p => {
      html += '<tr><td style="word-break:break-all">' + esc(p.url||p.page||'-') + '</td><td style="text-align:right">' + fmt(p.count) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // Top intents
  if (topIntents.length) {
    html += '<div class="panel"><h2>Top Intents</h2><table><thead><tr><th>Intent</th><th style="text-align:right">Count</th></tr></thead><tbody>';
    topIntents.slice(0,10).forEach(p => {
      html += '<tr><td>' + esc(p.intent||'-') + '</td><td style="text-align:right">' + fmt(p.count) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  html += rawSection(raw);
  document.getElementById('content').innerHTML = html;
}

function rawSection(raw) {
  return '<span class="raw-toggle" onclick="this.nextElementSibling.classList.toggle(\\'show\\')">Toggle raw JSON</span>' +
    '<pre class="raw">' + esc(JSON.stringify(raw, null, 2)) + '</pre>';
}
</script>
</body>
</html>`;

export function dashboardPageHtml() {
  return PAGE_HTML;
}
