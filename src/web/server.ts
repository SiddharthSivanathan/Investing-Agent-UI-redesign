/**
 * Value Investing Agent - Web Server
 *
 * Express HTTP server that exposes the analysis engine as a REST API
 * and serves the single-page web UI from /public.
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  getProvider,
  setProvider,
  getProviderInfo,
  getCurrentProviderName,
  createProvider,
} from '../providers/index.js';
import {
  calculateFinancialRatios,
  calculateDCF,
  calculateGrahamValuation,
  calculateMarginOfSafety,
  calculateCombinedMarginOfSafety,
  analyzeMoat,
  evaluateProfitability,
  evaluateSafety,
} from '../analysis/index.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// Minimal .env loader — avoids a runtime dependency on `dotenv`.
// Only sets variables not already present in process.env.
function loadDotEnv(file: string) {
  try {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    console.warn('[init] failed to read .env:', e instanceof Error ? e.message : e);
  }
}
loadDotEnv(path.join(PROJECT_ROOT, '.env'));

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Translate provider errors into UI-friendly messages.
 */
function friendlyError(active: string, raw: string, ticker?: string): {
  message: string;
  status: number;
  category: 'rate-limit' | 'forbidden' | 'not-found' | 'unknown';
} {
  const t = ticker ? ` "${ticker}"` : '';
  const isIndian = ticker ? /\.(NS|BO|BSE|NSE)$/i.test(ticker) : false;

  // 403 — usually means "ticker on exchange not covered by your tier"
  if (/(\b403\b|forbidden|premium)/i.test(raw)) {
    if (active === 'finnhub' && isIndian) {
      return {
        category: 'forbidden',
        status: 403,
        message:
          `Finnhub's free tier doesn't cover Indian exchanges. Try ticker${t} on Yahoo (use suffix .NS for NSE) ` +
          `or Alpha Vantage (use suffix .BSE) via Settings.`,
      };
    }
    return {
      category: 'forbidden',
      status: 403,
      message:
        `${active} returned "forbidden" for${t}. The free tier likely doesn't cover this exchange. ` +
        `Try switching providers via Settings.`,
    };
  }

  if (/Too Many Requests|429|rate ?limit|RateLimitError/i.test(raw)) {
    const guidance =
      active === 'alpha-vantage'
        ? 'Alpha Vantage free tier is 5 req/min, 25/day. Wait a minute (or until tomorrow) or switch providers via Settings.'
        : active === 'finnhub'
          ? 'Finnhub free tier is 60 req/min. Wait a moment and retry.'
          : 'Yahoo Finance throttled this IP. Switch to Finnhub via Settings, or wait ~1 min.';
    return {
      category: 'rate-limit',
      status: 429,
      message: `Upstream rate limit hit (${active}). ${guidance}`,
    };
  }

  if (/not found|TickerNotFound/i.test(raw)) {
    return {
      category: 'not-found',
      status: 404,
      message:
        `Ticker${t} not found on ${active}. ` +
        (isIndian
          ? active === 'alpha-vantage'
            ? 'For Indian stocks Alpha Vantage uses the .BSE suffix (e.g. IRFC.BSE).'
            : 'For Indian stocks Yahoo uses .NS (NSE) or .BO (BSE); Finnhub free tier doesn\'t cover India — switch provider in Settings.'
          : 'Check the symbol and try again.'),
    };
  }

  return { category: 'unknown', status: 500, message: raw };
}

function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Pull the actually-used provider name from the error itself
      // (`[provider-name]` prefix from BaseProvider) — falls back to the global active.
      const providerInError = raw.match(/^\[([a-z0-9-]+)\]/)?.[1];
      const active = (res.locals.providerUsed as string | undefined)
        || providerInError
        || getCurrentProviderName();
      const ticker = typeof req.params.ticker === 'string' ? req.params.ticker : undefined;
      const { message, status, category } = friendlyError(active, raw, ticker);
      console.error(`[api] ${req.method} ${req.path} (${active}):`, raw);
      res.status(status).json({ error: message, category, rateLimited: category === 'rate-limit' });
    }
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, provider: getCurrentProviderName() });
});

app.get('/api/providers', (_req, res) => {
  res.json({ active: getCurrentProviderName(), providers: getProviderInfo() });
});

app.post('/api/providers/active', wrap(async (req) => {
  const { name, apiKey } = req.body ?? {};
  if (!name) throw new Error('Missing provider name');
  await setProvider(name, { name, apiKey });
  return { active: getCurrentProviderName() };
}));

app.get('/api/search', wrap(async (req) => {
  const q = String(req.query.q || '').trim();
  if (!q) return { results: [] };
  const provider = getProvider();
  if (!provider.searchStocks) return { results: [] };
  const results = await provider.searchStocks(q);
  return { results: results.slice(0, 10) };
}));

app.get('/api/quote/:ticker', wrap(async (req) => {
  const quote = await getProvider().getQuote(req.params.ticker);
  return { quote };
}));

app.get('/api/profile/:ticker', wrap(async (req) => {
  const profile = await getProvider().getCompanyProfile(req.params.ticker);
  return { profile };
}));

app.get('/api/history/:ticker', wrap(async (req, res) => {
  const ticker = req.params.ticker;
  const picked = pickProviderForTicker(ticker);
  res.locals.providerUsed = picked.name;
  if (!picked.provider.getHistoricalPrices) return { history: [] };
  const years = Number(req.query.years ?? 1);
  const history = await picked.provider.getHistoricalPrices(ticker, years);
  // Downsample to keep payload small
  const step = Math.max(1, Math.floor(history.length / 200));
  const sampled = history.filter((_, i) => i % step === 0).map((h) => ({
    date: h.date,
    close: h.close,
  }));
  return { history: sampled };
}));

app.get('/api/news/:ticker', wrap(async (req) => {
  const provider = getProvider();
  if (!provider.getNews) return { news: [] };
  const days = Number(req.query.days ?? 7);
  const news = await provider.getNews(req.params.ticker, days);
  return { news: news.slice(0, 15) };
}));

/**
 * Pick a provider that can plausibly serve the given ticker.
 * Falls back to the configured default, then probes alternatives for
 * exchange-suffixed tickers that the active provider can't reach.
 */
function pickProviderForTicker(ticker: string) {
  const active = getCurrentProviderName();
  const t = ticker.toUpperCase();

  // Indian tickers — stockanalysis.com has full fundamentals (P&L, balance
  // sheet, cash flow) server-rendered + we delegate live quotes/charts to
  // yahoo-direct internally. This is the only working free path for Indian
  // fundamentals without a headless browser or paid API.
  if (/\.(NS|BO)$/i.test(t)) {
    try {
      return {
        provider: createProvider('stockanalysis'),
        name: 'stockanalysis',
        autoSwitched: true,
      };
    } catch { /* fallthrough */ }
  }

  // Other international suffixes (HK / TO / LSE / Paris / Frankfurt …) →
  // yahoo-direct still works for quote + chart; fundamentals will be sparse.
  if (/\.(HK|TO|L|PA|DE|MI|AS|MC|SW)$/i.test(t)) {
    try {
      return { provider: createProvider('yahoo-direct'), name: 'yahoo-direct', autoSwitched: true };
    } catch { /* fallthrough */ }
  }

  // Alpha Vantage style (.BSE / .NSE) → Alpha Vantage if a key is available
  if (/\.(BSE|NSE)$/i.test(t)) {
    const key = process.env.ALPHA_VANTAGE_API_KEY;
    if (key && active !== 'alpha-vantage') {
      try {
        return {
          provider: createProvider('alpha-vantage', { name: 'alpha-vantage', apiKey: key }),
          name: 'alpha-vantage',
          autoSwitched: true,
        };
      } catch { /* fallthrough */ }
    }
  }

  return { provider: getProvider(), name: active, autoSwitched: false };
}

/**
 * Full analysis endpoint — the heavy lifter the UI uses for the dashboard.
 */
app.get('/api/analyze/:ticker', wrap(async (req, res) => {
  const ticker = req.params.ticker;
  const picked = pickProviderForTicker(ticker);
  const provider = picked.provider;
  res.locals.providerUsed = picked.name;

  // Alpha Vantage free tier is 5 req/min — serialize to avoid bursts.
  const serialize = picked.name === 'alpha-vantage';
  const quote = await provider.getQuote(ticker);
  // Financials and profile are best-effort — providers like yahoo-direct don't
  // expose them, but we still want to render the dashboard with the quote +
  // chart + KPIs the user CAN see.
  const emptyFinancials = {
    ticker,
    incomeStatements: [],
    balanceSheets: [],
    cashFlowStatements: [],
    currency: quote.currency,
    lastUpdated: new Date(),
  };
  const financialsPromise = provider.getFinancials(ticker, 5).catch((e: unknown) => {
    console.warn(`[analyze] financials unavailable for ${ticker}:`, e instanceof Error ? e.message : e);
    return emptyFinancials;
  });
  const profilePromise = provider.getCompanyProfile(ticker).catch(() => null);
  const [financials, profile] = serialize
    ? [await financialsPromise, await profilePromise]
    : await Promise.all([financialsPromise, profilePromise]);
  const hasFinancials = financials.incomeStatements.length > 0;

  const ratios = calculateFinancialRatios(financials, quote);
  const profitability = evaluateProfitability(ratios);
  const safety = evaluateSafety(ratios);

  const dcfParams = {
    discountRate: Number(req.query.discountRate ?? DEFAULT_CONFIG.analysis.discountRate),
    terminalGrowthRate: Number(req.query.terminalGrowth ?? DEFAULT_CONFIG.analysis.terminalGrowthRate),
    projectionYears: Number(req.query.projectionYears ?? DEFAULT_CONFIG.analysis.projectionYears),
  };

  const dcf = calculateDCF(financials, quote, dcfParams);
  const graham = calculateGrahamValuation(financials, quote, DEFAULT_CONFIG.analysis.riskFreeRate);

  const valuations = {
    dcf: dcf.intrinsicValue || null,
    grahamNumber: graham.grahamNumber || null,
    grahamGrowth: graham.grahamGrowthValue,
  };
  const margin = calculateCombinedMarginOfSafety(quote.price, valuations);
  const dcfMargin = calculateMarginOfSafety(quote.price, dcf.intrinsicValue);

  let moat: unknown = null;
  if (profile) {
    try {
      moat = analyzeMoat(financials, quote, profile);
    } catch (e) {
      console.warn('[api] moat analysis failed:', e);
    }
  }

  return {
    ticker,
    quote,
    profile,
    ratios,
    profitability,
    safety,
    dcf,
    dcfMargin,
    graham,
    margin,
    moat,
    providerUsed: picked.name,
    autoSwitched: picked.autoSwitched,
    hasFinancials,
    dataNotice: hasFinancials
      ? null
      : `Full financial statements aren't available for ${ticker} from this provider. ` +
        `Showing live quote and price chart only. ` +
        (picked.name === 'yahoo-direct'
          ? 'For full DCF / ratios, try Alpha Vantage (.BSE suffix) — see Settings.'
          : 'Try a different provider via Settings.'),
    financials: {
      incomeStatements: financials.incomeStatements,
      balanceSheets: financials.balanceSheets,
      cashFlowStatements: financials.cashFlowStatements,
      currency: financials.currency,
    },
  };
}));

// Serve static frontend
app.use(express.static(PUBLIC_DIR));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '0.0.0.0';

// Activate provider from environment on startup
async function bootstrapProvider() {
  const initial = process.env.PROVIDER || 'yahoo-finance';
  const apiKey =
    initial === 'finnhub' ? process.env.FINNHUB_API_KEY :
    initial === 'alpha-vantage' ? process.env.ALPHA_VANTAGE_API_KEY :
    undefined;
  try {
    if (initial === 'yahoo-finance') {
      // No health check (Yahoo is rate-limited; assume OK).
      createProvider(initial);
    } else {
      await setProvider(initial, apiKey ? { name: initial, apiKey } : { name: initial });
    }
  } catch (e) {
    console.warn(`[init] could not activate ${initial}: ${e instanceof Error ? e.message : e}`);
    console.warn('[init] falling back to yahoo-finance');
    try { createProvider('yahoo-finance'); } catch {}
  }
}

bootstrapProvider().finally(() => {
  app.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Value Investing Agent — Web UI');
    console.log(`  ▸ http://${HOST}:${PORT}`);
    console.log(`  ▸ Provider: ${getCurrentProviderName()}`);
    console.log('');
  });
});
