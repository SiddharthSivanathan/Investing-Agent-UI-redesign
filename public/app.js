/* Value Investing Agent — frontend */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  ticker: null,
  data: null,
  charts: {},
  years: 3,
};

const fmtMoney = (v, currency = 'USD') => {
  if (v == null || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
};
const fmtNum = (v, digits = 2) => (v == null || !isFinite(v) ? '—' : v.toFixed(digits));
const fmtPct = (v, digits = 1) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ---------- Provider ----------
const PROVIDER_HINTS = {
  'yahoo-finance': 'No key. Covers global stocks incl. Indian (.NS / .BO). Rate-limited per IP.',
  'finnhub': 'Free key. US stocks only on free tier (60 req/min).',
  'alpha-vantage': 'Free key. US + Indian (.BSE). Hard cap: 25 req/day.',
};

async function loadProviders() {
  try {
    const r = await fetch('/api/providers').then((r) => r.json());
    $('#provider-pill').textContent = r.active;
    const list = $('#provider-list');
    list.innerHTML = '';
    r.providers.forEach((p) => {
      const row = document.createElement('label');
      row.className = 'flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10';
      row.innerHTML = `
        <input type="radio" name="provider" value="${p.name}" ${p.isActive ? 'checked' : ''} class="accent-amber-400" />
        <div class="flex-1 min-w-0">
          <div class="font-medium">${p.displayName}</div>
          <div class="text-xs text-slate-400">${PROVIDER_HINTS[p.name] || (p.requiresApiKey ? 'API key required' : 'No key needed')}</div>
        </div>
        ${p.isActive ? '<span class="pill pill-good">active</span>' : ''}
      `;
      list.appendChild(row);
    });
  } catch (e) {
    console.warn('providers load failed', e);
  }
}

$('#provider-btn').addEventListener('click', () => show($('#modal')));
$('#modal-close').addEventListener('click', () => hide($('#modal')));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') hide($('#modal')); });

$('#provider-save').addEventListener('click', async () => {
  const name = document.querySelector('input[name="provider"]:checked')?.value;
  const apiKey = $('#provider-key').value.trim() || undefined;
  if (!name) return;
  const btn = $('#provider-save');
  const originalText = btn.textContent;
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/providers/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, apiKey }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    hide($('#modal'));
    $('#provider-key').value = '';
  } catch (e) {
    alert('Could not switch provider: ' + e.message);
  } finally {
    // ALWAYS re-sync the UI from the server so the pill matches backend reality,
    // regardless of whether the switch succeeded.
    await loadProviders();
    btn.textContent = originalText;
    btn.disabled = false;
  }
});

// ---------- Search & analyze ----------
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { hide($('#suggestions')); return; }
  searchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
      const box = $('#suggestions');
      if (!r.results?.length) { hide(box); return; }
      box.innerHTML = r.results.map((s) => `
        <div class="item" data-ticker="${s.ticker}">
          <div>
            <div class="font-medium text-slate-100">${s.ticker}</div>
            <div class="text-xs text-slate-400">${s.name}</div>
          </div>
          <span class="text-xs text-slate-500">${s.exchange}</span>
        </div>
      `).join('');
      box.querySelectorAll('.item').forEach((el) => {
        el.addEventListener('click', () => {
          $('#search').value = el.dataset.ticker;
          hide(box);
          analyze(el.dataset.ticker);
        });
      });
      show(box);
    } catch {}
  }, 200);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#search') && !e.target.closest('#suggestions')) hide($('#suggestions'));
});

$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const t = e.target.value.trim();
    if (t) analyze(t);
  }
});
$('#analyze-btn').addEventListener('click', () => {
  const t = $('#search').value.trim();
  if (t) analyze(t);
});
$$('.chip').forEach((c) => c.addEventListener('click', () => {
  $('#search').value = c.dataset.ticker;
  analyze(c.dataset.ticker);
}));

async function analyze(ticker) {
  state.ticker = ticker.toUpperCase();
  hide($('#error'));
  hide($('#results'));
  hide($('#empty'));
  show($('#loading'));
  try {
    const data = await fetch(`/api/analyze/${encodeURIComponent(state.ticker)}`).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body;
    });
    state.data = data;
    render(data);
    show($('#results'));
    loadPriceChart();
    // If the server auto-routed (e.g. picked Yahoo for IRFC.NS), reflect it.
    if (data.autoSwitched && data.providerUsed) {
      $('#provider-pill').textContent = `${data.providerUsed} (auto)`;
    }
  } catch (e) {
    const errBox = $('#error');
    errBox.innerHTML = `
      <div class="flex items-start gap-3">
        <span class="text-xl leading-none">⚠️</span>
        <div>
          <div class="font-medium mb-1">Could not analyze ${state.ticker}</div>
          <div class="text-sm text-rose-200/90">${e.message}</div>
        </div>
      </div>
    `;
    show(errBox);
    // Refresh provider pill in case backend state changed.
    loadProviders();
  } finally {
    hide($('#loading'));
  }
}

// ---------- Render ----------
function render(d) {
  const { quote, profile, ratios, dcf, dcfMargin, graham, margin, moat, dataNotice, hasFinancials } = d;

  $('#r-ticker').textContent = quote.ticker;
  $('#r-exchange').textContent = quote.exchange || '';
  $('#r-name').textContent = quote.name || '';
  $('#r-sector').textContent = profile && profile.sector !== 'Unknown'
    ? `${profile.sector} · ${profile.industry}`
    : '';
  $('#r-price').textContent = fmtMoney(quote.price, quote.currency);
  $('#r-currency').textContent = quote.currency || 'USD';

  // Surface "partial data" notices (e.g. quote-only for Indian stocks via direct chart endpoint).
  const noticeEl = $('#data-notice');
  if (dataNotice) {
    noticeEl.textContent = dataNotice;
    show(noticeEl);
  } else {
    hide(noticeEl);
  }

  // Quote-only mode: hide misleading "Overvalued -100%" verdict & valuation/moat tabs,
  // keep KPI/price-chart so users still get value.
  document.body.classList.toggle('no-financials', !hasFinancials);

  const ch = quote.change || 0;
  const chp = quote.changePercent || 0;
  const cls = ch >= 0 ? 'text-jade-400' : 'text-rose-400';
  $('#r-change').innerHTML = `<span class="${cls}">${ch >= 0 ? '▲' : '▼'} ${fmtMoney(Math.abs(ch), quote.currency)} (${chp.toFixed(2)}%)</span>`;

  // Verdict — when we have no fundamentals, don't pretend the stock is "overvalued"
  if (!hasFinancials) {
    $('#verdict-status').innerHTML = `<span class="text-slate-300">Quote only</span>`;
    $('#verdict-mos').innerHTML = `<span class="text-slate-500 text-base">—</span>`;
    $('#verdict-text').textContent =
      'Valuation requires income / balance-sheet / cash-flow data, which this provider does not return for this ticker. ' +
      'Live price and chart are available.';
  } else {
    const mos = margin.combinedMarginOfSafety;
    const status = margin.status;
    const statusClasses = {
      undervalued: ['text-jade-400', 'pill-good', 'Undervalued'],
      fair: ['text-gold-400', 'pill-warn', 'Fair value'],
      overvalued: ['text-rose-400', 'pill-bad', 'Overvalued'],
    }[status] || ['text-slate-300', 'pill-muted', 'Unknown'];
    $('#verdict-status').innerHTML = `<span class="${statusClasses[0]}">${statusClasses[2]}</span>`;
    $('#verdict-mos').innerHTML = `<span class="${statusClasses[0]}">${fmtPct(mos)}</span>`;
    $('#verdict-text').textContent = margin.recommendation;
  }

  // KPIs — substitute meaningful quote-only metrics when fundamentals are absent
  const kpis = hasFinancials
    ? [
        { label: 'Market cap', value: fmtMoney(quote.marketCap, quote.currency) },
        { label: 'P/E', value: fmtNum(quote.pe), sub: bench('pe', quote.pe) },
        { label: 'P/B', value: fmtNum(quote.pb), sub: bench('pb', quote.pb) },
        { label: 'ROE', value: fmtPct(ratios.roe), sub: bench('roe', ratios.roe) },
        { label: 'Gross margin', value: fmtPct(ratios.grossMargin), sub: bench('gm', ratios.grossMargin) },
        { label: 'Debt/Equity', value: fmtNum(ratios.debtToEquity), sub: bench('de', ratios.debtToEquity) },
        { label: 'FCF yield', value: fmtPct(ratios.fcfYield) },
        { label: 'Div yield', value: fmtPct(quote.dividendYield) },
      ]
    : [
        { label: '52W high', value: fmtMoney(quote.week52High, quote.currency) },
        { label: '52W low', value: fmtMoney(quote.week52Low, quote.currency) },
        {
          label: '% off 52W high',
          value: quote.week52High
            ? `${(((quote.week52High - quote.price) / quote.week52High) * 100).toFixed(1)}%`
            : '—',
        },
        {
          label: '% above 52W low',
          value: quote.week52Low
            ? `${(((quote.price - quote.week52Low) / quote.week52Low) * 100).toFixed(1)}%`
            : '—',
        },
        { label: 'Day high', value: fmtMoney(quote.high, quote.currency) },
        { label: 'Day low', value: fmtMoney(quote.low, quote.currency) },
        { label: 'Volume', value: quote.volume ? quote.volume.toLocaleString() : '—' },
        { label: 'Previous close', value: fmtMoney(quote.previousClose, quote.currency) },
      ];
  $('#kpi-grid').innerHTML = kpis.map((k) => `
    <div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      ${k.sub ? `<div class="kpi-sub">${k.sub}</div>` : ''}
    </div>
  `).join('');

  if (hasFinancials) {
    // Make sure the graham heading is visible (might have been hidden on a previous "quote only" render)
    const grahamHeader = $('#graham-criteria')?.parentElement;
    if (grahamHeader) grahamHeader.style.display = '';
    renderValuation(d);
    renderMoat(moat);
    renderRatios(ratios);
    renderFinancials(d.financials);
  } else {
    const unavailable = `
      <div class="text-center py-12 text-slate-400">
        <div class="text-4xl mb-3">📊</div>
        <p class="font-medium text-slate-300 mb-1">Financial statements not available</p>
        <p class="text-sm max-w-md mx-auto">This provider returns live quotes only for ${quote.ticker}.
        For full DCF / ratios / moat analysis, switch providers via Settings — Alpha Vantage covers Indian stocks with the .BSE suffix.</p>
      </div>
    `;
    $('#valuation-summary').innerHTML = unavailable;
    $('#graham-criteria').innerHTML = '';
    // Hide the "Graham defensive criteria" section heading when there's nothing under it
    const grahamHeader = $('#graham-criteria').parentElement;
    if (grahamHeader) grahamHeader.style.display = 'none';
    $('#moat-detail').innerHTML = unavailable;
    $('#ratios-grid').innerHTML = unavailable;
    $('#financials-table').innerHTML = `<tbody><tr><td>${unavailable}</td></tr></tbody>`;
    // Destroy stale charts so old data doesn't linger
    if (state.charts.dcf) { state.charts.dcf.destroy(); state.charts.dcf = null; }
    if (state.charts.moat) { state.charts.moat.destroy(); state.charts.moat = null; }
    const titleEl = document.getElementById('dcf-chart-title');
    if (titleEl) titleEl.textContent = 'DATA UNAVAILABLE';
  }
}

function bench(key, v) {
  if (v == null || !isFinite(v)) return '';
  const checks = {
    pe: v < 15 ? '<span class="text-jade-400">cheap</span>' : v < 25 ? '<span class="text-gold-400">fair</span>' : '<span class="text-rose-400">expensive</span>',
    pb: v < 1.5 ? '<span class="text-jade-400">cheap</span>' : v < 3 ? '<span class="text-gold-400">fair</span>' : '<span class="text-rose-400">expensive</span>',
    roe: v >= 0.15 ? '<span class="text-jade-400">strong</span>' : v >= 0.10 ? '<span class="text-gold-400">ok</span>' : '<span class="text-rose-400">weak</span>',
    gm: v >= 0.40 ? '<span class="text-jade-400">pricing power</span>' : v >= 0.25 ? '<span class="text-gold-400">moderate</span>' : '<span class="text-rose-400">commodity</span>',
    de: v < 0.5 ? '<span class="text-jade-400">conservative</span>' : v < 1.0 ? '<span class="text-gold-400">moderate</span>' : '<span class="text-rose-400">leveraged</span>',
  };
  return checks[key] || '';
}

function renderValuation(d) {
  const { dcf, graham, margin, quote, financials } = d;
  const cashSourceLabels = {
    'fcf': 'Free cash flow',
    'ocf': 'Operating cash flow (FCF unavailable)',
    'owner-earnings': "Owner earnings (Buffett's measure)",
    'net-income': 'Net income (FCF unavailable)',
  };
  const cashSource = dcf?.assumptions?.cashSource;
  const dcfLabel = cashSource && cashSource !== 'fcf'
    ? `DCF intrinsic value · using ${cashSourceLabels[cashSource]}`
    : 'DCF intrinsic value';
  const rows = [
    { label: dcfLabel, value: dcf.intrinsicValue, price: quote.price },
    { label: 'Graham number (defensive)', value: graham.grahamNumber, price: quote.price },
    { label: 'Graham growth value', value: graham.grahamGrowthValue, price: quote.price },
  ];
  $('#valuation-summary').innerHTML = `
    <p class="text-xs uppercase tracking-widest text-slate-400 mb-3">Intrinsic value estimates</p>
    <div class="space-y-3">
      ${rows.map((r) => {
        if (r.value == null || r.value <= 0) return `
          <div class="criterion flex justify-between">
            <span class="text-slate-300">${r.label}</span>
            <span class="text-slate-500">n/a</span>
          </div>
        `;
        const mos = (r.value - r.price) / r.value;
        const cls = mos >= 0.25 ? 'pill-good' : mos >= 0 ? 'pill-warn' : 'pill-bad';
        return `
          <div class="criterion">
            <div class="flex justify-between items-center">
              <span class="text-slate-300">${r.label}</span>
              <span class="font-display text-lg">${fmtMoney(r.value, quote.currency)}</span>
            </div>
            <div class="mt-1 flex justify-between items-center text-xs">
              <span class="text-slate-500">vs price ${fmtMoney(r.price, quote.currency)}</span>
              <span class="pill ${cls}">${fmtPct(mos)} MOS</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="mt-4 p-4 rounded-xl bg-gradient-to-br from-gold-500/10 to-amber-300/5 border border-gold-500/20">
      <p class="text-xs uppercase tracking-widest text-gold-400 mb-1">Combined estimate</p>
      <div class="flex items-baseline justify-between">
        <div class="font-display text-2xl">${fmtMoney(margin.averageIntrinsicValue, quote.currency)}</div>
        <div class="text-sm text-slate-400">${fmtPct(margin.combinedMarginOfSafety)} margin of safety</div>
      </div>
    </div>
  `;

  // Chart of projected cash flow — or fall back to historical income data
  drawDcfChart(dcf, financials);
  // Swap the chart's section title to reflect what we're actually showing
  const titleEl = document.querySelector('#tab-valuation p.text-xs.uppercase.tracking-widest:nth-of-type(1)');
  // (No-op if structure changes — chart title is set inline in drawDcfChart)

  // Defensive criteria
  $('#graham-criteria').innerHTML = graham.defensiveCriteria.map((c) => `
    <div class="criterion">
      <div class="flex justify-between items-center">
        <span class="text-slate-200">${c.criterion}</span>
        <span class="pill ${c.passed ? 'pill-good' : 'pill-bad'}">${c.passed ? 'pass' : 'fail'}</span>
      </div>
      <div class="text-xs text-slate-500 mt-1">${c.detail}</div>
    </div>
  `).join('');
}

function drawDcfChart(dcf, financials) {
  if (state.charts.dcf) state.charts.dcf.destroy();
  const ctx = document.getElementById('dcf-chart');
  const titleEl = document.getElementById('dcf-chart-title');

  // CASE 1 — DCF projection available: show projected cash + terminal value bar
  if (dcf?.projectedFcf?.length) {
    const labels = dcf.projectedFcf.map((_, i) => `Y${i + 1}`);
    const tvBar = Array(dcf.projectedFcf.length - 1).fill(null);
    tvBar.push(dcf.terminalValue || 0);

    const sourceLabel = {
      fcf: 'Projected free cash flow',
      ocf: 'Projected operating cash flow',
      'owner-earnings': 'Projected owner earnings',
      'net-income': 'Projected net income',
    }[dcf.assumptions?.cashSource] || 'Projected cash flow';
    if (titleEl) titleEl.textContent = sourceLabel.toUpperCase();

    state.charts.dcf = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: sourceLabel,
            data: dcf.projectedFcf,
            backgroundColor: 'rgba(230,185,76,0.5)',
            borderColor: '#e6b94c',
            borderWidth: 1.5,
            borderRadius: 6,
          },
          {
            label: 'Terminal value (year ' + dcf.projectedFcf.length + ')',
            data: tvBar,
            backgroundColor: 'rgba(54,211,153,0.35)',
            borderColor: '#36d399',
            borderWidth: 1.5,
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...chartOpts({ y: { format: (v) => fmtMoney(v) } }),
        plugins: {
          legend: {
            display: true,
            labels: { color: '#cbd5e1', boxWidth: 12, font: { size: 11 } },
            position: 'bottom',
          },
          tooltip: {
            backgroundColor: '#0b0f17',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            titleColor: '#f4cf6b',
            bodyColor: '#e2e8f0',
            callbacks: { label: (c) => `${c.dataset.label}: ${fmtMoney(c.parsed.y)}` },
          },
        },
      },
    });
    return;
  }

  // CASE 2 — DCF couldn't run: show historical revenue + net income + FCF instead
  // so the user still gets a fundamentals picture.
  const stmts = (financials?.incomeStatements || []).slice().reverse();
  const cfs = (financials?.cashFlowStatements || []).slice().reverse();
  if (!stmts.length) {
    if (titleEl) titleEl.textContent = 'NO HISTORICAL DATA';
    state.charts.dcf = new Chart(ctx, {
      type: 'bar',
      data: { labels: [], datasets: [] },
      options: chartOpts({ y: { format: (v) => fmtMoney(v) } }),
    });
    return;
  }
  if (titleEl) titleEl.textContent = 'HISTORICAL FUNDAMENTALS (DCF UNAVAILABLE)';
  const labels = stmts.map((s) => s.fiscalYear);

  state.charts.dcf = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Revenue',
          data: stmts.map((s) => s.revenue),
          backgroundColor: 'rgba(230,185,76,0.5)',
          borderColor: '#e6b94c',
          borderWidth: 1.5,
          borderRadius: 6,
        },
        {
          label: 'Net income',
          data: stmts.map((s) => s.netIncome),
          backgroundColor: 'rgba(54,211,153,0.5)',
          borderColor: '#36d399',
          borderWidth: 1.5,
          borderRadius: 6,
        },
        {
          label: 'Free cash flow',
          data: cfs.map((c) => c.freeCashFlow),
          backgroundColor: 'rgba(125,140,255,0.5)',
          borderColor: '#7d8cff',
          borderWidth: 1.5,
          borderRadius: 6,
        },
      ],
    },
    options: {
      ...chartOpts({ y: { format: (v) => fmtMoney(v) } }),
      plugins: {
        legend: {
          display: true,
          labels: { color: '#cbd5e1', boxWidth: 12, font: { size: 11 } },
          position: 'bottom',
        },
        tooltip: {
          backgroundColor: '#0b0f17',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#f4cf6b',
          bodyColor: '#e2e8f0',
          callbacks: { label: (c) => `${c.dataset.label}: ${fmtMoney(c.parsed.y)}` },
        },
      },
    },
  });
}

function renderMoat(moat) {
  if (!moat) {
    $('#moat-detail').innerHTML = '<p class="text-slate-400 text-sm">Moat analysis unavailable.</p>';
    return;
  }
  const dims = moat.dimensions;
  const labels = ['Brand', 'Cost', 'Network', 'Switching', 'Scale'];
  const values = [
    dims.brandPower.score,
    dims.costAdvantage.score,
    dims.networkEffect.score,
    dims.switchingCosts.score,
    dims.scaleEconomies.score,
  ];

  if (state.charts.moat) state.charts.moat.destroy();
  const ctx = document.getElementById('moat-chart');
  state.charts.moat = new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: moat.companyName,
        data: values,
        backgroundColor: 'rgba(230,185,76,0.25)',
        borderColor: '#e6b94c',
        borderWidth: 2,
        pointBackgroundColor: '#e6b94c',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          beginAtZero: true,
          max: 5,
          angleLines: { color: 'rgba(255,255,255,0.08)' },
          grid: { color: 'rgba(255,255,255,0.08)' },
          pointLabels: { color: '#cbd5e1', font: { size: 12 } },
          ticks: { color: '#64748b', backdropColor: 'transparent', stepSize: 1 },
        },
      },
    },
  });

  const ratingPill = {
    wide: ['pill-good', 'Wide moat'],
    narrow: ['pill-warn', 'Narrow moat'],
    none: ['pill-muted', 'No moat'],
  }[moat.moatRating] || ['pill-muted', '—'];

  const durabilityPill = {
    strong: ['pill-good', 'Strong durability'],
    moderate: ['pill-warn', 'Moderate durability'],
    weak: ['pill-bad', 'Weak durability'],
  }[moat.durability.assessment] || ['pill-muted', '—'];

  const dimList = [
    ['Brand power', dims.brandPower],
    ['Cost advantage', dims.costAdvantage],
    ['Network effect', dims.networkEffect],
    ['Switching costs', dims.switchingCosts],
    ['Scale', dims.scaleEconomies],
  ];

  $('#moat-detail').innerHTML = `
    <div class="flex gap-2 mb-4">
      <span class="pill ${ratingPill[0]}">${ratingPill[1]}</span>
      <span class="pill ${durabilityPill[0]}">${durabilityPill[1]}</span>
      <span class="pill pill-muted">Score ${moat.overallScore.toFixed(1)} / 5</span>
    </div>
    <div class="space-y-2">
      ${dimList.map(([n, dim]) => `
        <details class="criterion">
          <summary class="cursor-pointer flex justify-between items-center">
            <span>${n}</span>
            <span class="text-sm text-slate-400">${dim.score.toFixed(1)} / 5</span>
          </summary>
          <ul class="mt-2 space-y-1 text-xs text-slate-400 list-disc pl-5">
            ${dim.evidence.map((e) => `<li>${e}</li>`).join('')}
          </ul>
        </details>
      `).join('')}
    </div>
  `;
}

function renderRatios(r) {
  const groups = [
    ['Valuation', [
      ['P/E', fmtNum(r.pe)],
      ['P/B', fmtNum(r.pb)],
      ['P/S', fmtNum(r.ps)],
      ['PEG', fmtNum(r.peg)],
      ['EV / EBITDA', fmtNum(r.evToEbitda)],
      ['P / FCF', fmtNum(r.priceToFcf)],
    ]],
    ['Profitability', [
      ['Gross margin', fmtPct(r.grossMargin)],
      ['Operating margin', fmtPct(r.operatingMargin)],
      ['Net margin', fmtPct(r.netMargin)],
      ['ROE', fmtPct(r.roe)],
      ['ROA', fmtPct(r.roa)],
      ['ROIC', fmtPct(r.roic)],
    ]],
    ['Safety & growth', [
      ['Current ratio', fmtNum(r.currentRatio)],
      ['Quick ratio', fmtNum(r.quickRatio)],
      ['Debt / Equity', fmtNum(r.debtToEquity)],
      ['Interest cov.', fmtNum(r.interestCoverage)],
      ['Revenue 5Y CAGR', fmtPct(r.revenueGrowth5Y)],
      ['EPS 5Y CAGR', fmtPct(r.epsGrowth5Y)],
    ]],
  ];
  $('#ratios-grid').innerHTML = groups.map(([name, rows]) => `
    <div class="criterion">
      <p class="text-xs uppercase tracking-widest text-gold-400 mb-3">${name}</p>
      <div class="space-y-2 text-sm">
        ${rows.map(([k, v]) => `
          <div class="flex justify-between">
            <span class="text-slate-400">${k}</span>
            <span class="font-medium">${v}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function renderFinancials(f) {
  const years = f.incomeStatements.map((s) => s.fiscalYear);
  const row = (label, getter) => `
    <tr>
      <td>${label}</td>
      ${f.incomeStatements.map((s, i) => `<td>${getter(s, f.balanceSheets[i], f.cashFlowStatements[i])}</td>`).join('')}
    </tr>
  `;
  $('#financials-table').innerHTML = `
    <thead><tr><th></th>${years.map((y) => `<th>${y}</th>`).join('')}</tr></thead>
    <tbody>
      ${row('Revenue', (i) => fmtMoney(i.revenue))}
      ${row('Gross profit', (i) => fmtMoney(i.grossProfit))}
      ${row('Operating income', (i) => fmtMoney(i.operatingIncome))}
      ${row('Net income', (i) => fmtMoney(i.netIncome))}
      ${row('EPS', (i) => fmtNum(i.eps))}
      ${row('Total assets', (_i, b) => b ? fmtMoney(b.totalAssets) : '—')}
      ${row('Total debt', (_i, b) => b ? fmtMoney(b.totalDebt) : '—')}
      ${row('Equity', (_i, b) => b ? fmtMoney(b.totalEquity) : '—')}
      ${row('Operating CF', (_i, _b, c) => c ? fmtMoney(c.operatingCashFlow) : '—')}
      ${row('Free cash flow', (_i, _b, c) => c ? fmtMoney(c.freeCashFlow) : '—')}
    </tbody>
  `;
}

// ---------- Price chart ----------
async function loadPriceChart() {
  if (!state.ticker) return;
  try {
    const r = await fetch(`/api/history/${encodeURIComponent(state.ticker)}?years=${state.years}`).then((r) => r.json());
    drawPriceChart(r.history);
  } catch (e) { console.warn(e); }
}

function drawPriceChart(history) {
  if (state.charts.price) state.charts.price.destroy();
  const ctx = document.getElementById('price-chart');
  const labels = history.map((h) => new Date(h.date).toLocaleDateString());
  const data = history.map((h) => h.close);

  const grad = ctx.getContext('2d').createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, 'rgba(230,185,76,0.4)');
  grad.addColorStop(1, 'rgba(230,185,76,0)');

  state.charts.price = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: state.ticker,
        data,
        borderColor: '#e6b94c',
        backgroundColor: grad,
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: chartOpts({ x: { showTicks: 6 } }),
  });
}

$$('.range-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.range-btn').forEach((x) => x.classList.remove('range-active'));
  b.classList.add('range-active');
  state.years = Number(b.dataset.years);
  loadPriceChart();
}));

// ---------- Tabs ----------
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('tab-active'));
  t.classList.add('tab-active');
  const id = t.dataset.tab;
  $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
  $(`#tab-${id}`).classList.remove('hidden');
  // Resize charts when re-shown
  setTimeout(() => Object.values(state.charts).forEach((c) => c?.resize?.()), 50);
}));

// ---------- Chart defaults ----------
function chartOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0b0f17',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        titleColor: '#f4cf6b',
        bodyColor: '#e2e8f0',
      },
    },
    scales: {
      x: {
        ticks: {
          color: '#64748b',
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: extra.x?.showTicks || 8,
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
      },
      y: {
        ticks: {
          color: '#64748b',
          callback: extra.y?.format || ((v) => v),
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
      },
    },
  };
}

// init
loadProviders();
