/**
 * StockAnalysis.com Provider
 *
 * Scrapes server-rendered HTML from stockanalysis.com for Indian (NSE/BSE)
 * stocks. Unlike screener.in, the numeric values are present in the initial
 * HTML payload — no JS rendering required, so a plain HTTP fetch + cheerio
 * gets us 5 years of P&L / balance sheet / cash flow.
 *
 * Trade-off: this is an HTML scrape, so if the upstream changes its markup
 * we'll see empty results. The parser is tolerant — it looks up rows by
 * label fragments rather than fixed column positions.
 *
 * For historical price bars we delegate to YahooDirectProvider — same
 * lightweight chart endpoint we already trust for Indian quotes.
 */

import * as cheerio from 'cheerio';
import { BaseProvider, TickerNotFoundError } from './base.js';
import { YahooDirectProvider } from './yahoo-direct.js';
import type {
  BalanceSheet,
  CashFlowStatement,
  CompanyProfile,
  Financials,
  HistoricalPrice,
  IncomeStatement,
  ProviderConfig,
  StockQuote,
} from './types.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const BASE = 'https://stockanalysis.com';

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Parse a "1,234.56" / "1,234" / "-25" / "12.5%" cell into a number.
 * Returns NaN for unparseable cells (the row may have e.g. a "-" placeholder).
 *
 * stockanalysis.com uses US-style 1,234,567.89 grouping (not Indian lakhs),
 * which we just strip.
 */
function parseNum(raw: string): number {
  const cleaned = raw.replace(/,/g, '').replace(/%/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === 'N/A') return NaN;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Extract a numeric series for a row matching `labelPattern` (case-insensitive
 * substring). Returns the cells in left-to-right order (which on
 * stockanalysis.com is most-recent FY first).
 */
function readRow($: cheerio.CheerioAPI, labelPattern: RegExp): number[] | null {
  let found: number[] | null = null;
  $('tr').each((_, tr) => {
    if (found) return;
    const $tr = $(tr);
    // stockanalysis decorates labels with expand icons / footnote markers
    // ("Revenue +", "Net Income *"). Strip trailing non-alpha decoration
    // before matching so simple anchored patterns still work.
    const raw = $tr.find('td').first().text();
    const normalized = raw.replace(/\s+/g, ' ').replace(/[+*†‡]\s*$/g, '').trim();
    if (!labelPattern.test(normalized)) return;
    const vals: number[] = [];
    $tr.find('td').each((idx, td) => {
      if (idx === 0) return; // skip label column
      const v = parseNum($(td).text());
      if (Number.isFinite(v)) vals.push(v);
    });
    if (vals.length) found = vals;
  });
  return found;
}

/**
 * Pull the fiscal-year labels from the table's <thead>.
 * Returns canonical 4-digit year strings ("2026", "2025", ...).
 */
function readFiscalYears($: cheerio.CheerioAPI): string[] {
  const years: string[] = [];
  $('thead th').each((_, th) => {
    const t = $(th).text().trim();
    const m = t.match(/FY\s*(\d{4})/i) || t.match(/(\d{4})/);
    if (m && !years.includes(m[1])) years.push(m[1]);
  });
  return years;
}

// ---------------------------------------------------------------------------
// Ticker mapping — Yahoo "RELIANCE.NS" → stockanalysis "nse/RELIANCE"
// ---------------------------------------------------------------------------

function toStockAnalysisPath(ticker: string): { exchange: 'nse' | 'bse'; symbol: string } | null {
  const t = ticker.toUpperCase();
  if (t.endsWith('.NS')) return { exchange: 'nse', symbol: t.slice(0, -3) };
  if (t.endsWith('.BO')) return { exchange: 'bse', symbol: t.slice(0, -3) };
  // Bare symbols default to NSE — most common for Indian stocks.
  if (/^[A-Z0-9&-]{2,15}$/.test(t)) return { exchange: 'nse', symbol: t };
  return null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class StockAnalysisProvider extends BaseProvider {
  readonly name = 'stockanalysis';
  readonly displayName = 'StockAnalysis.com';
  readonly requiresApiKey = false;

  /**
   * Yahoo's chart endpoint backs our historical-price fetches — stockanalysis
   * doesn't expose daily OHLCV in a scrape-friendly form. We instantiate one
   * yahoo-direct provider per instance so the inner fetch reuses its caching
   * / header logic.
   */
  private yahoo = new YahooDirectProvider();

  constructor(config?: ProviderConfig) {
    super(config);
  }

  // -------------------------------------------------------------------------
  // Quote — comes off the overview page; we also let yahoo-direct serve quotes
  // since its chart endpoint is more reliable for the live price specifically.
  // -------------------------------------------------------------------------

  protected async fetchQuote(ticker: string): Promise<StockQuote> {
    // Live price is best from yahoo-direct — same provider we already use for
    // Indian quotes. We don't re-scrape stockanalysis just for the price.
    return this.yahoo.getQuote(ticker);
  }

  // -------------------------------------------------------------------------
  // Company profile — name + sector + industry from the overview page
  // -------------------------------------------------------------------------

  protected async fetchCompanyProfile(ticker: string): Promise<CompanyProfile> {
    const mapped = toStockAnalysisPath(ticker);
    if (!mapped) throw new TickerNotFoundError(this.name, ticker);

    const html = await fetchHtml(`${BASE}/quote/${mapped.exchange}/${mapped.symbol}/`);
    if (!html) {
      // Fall back to yahoo-direct profile so the dashboard still labels things.
      return this.yahoo.getCompanyProfile(ticker);
    }
    const $ = cheerio.load(html);

    // <h1> is the company name; subheadings carry exchange / industry.
    const name = $('h1').first().text().trim() || ticker;
    // Sector / industry usually live in the "Profile" sidebar block.
    const profileText = $('#mc-quote-profile, .profile, [data-test="profile"]').text();
    const sectorMatch = profileText.match(/Sector\s*:?\s*([A-Za-z &/]+)/);
    const industryMatch = profileText.match(/Industry\s*:?\s*([A-Za-z &/]+)/);

    return {
      ticker,
      name,
      description: '',
      sector: sectorMatch?.[1]?.trim() || 'Unknown',
      industry: industryMatch?.[1]?.trim() || 'Unknown',
      employees: null,
      website: '',
      country: 'India',
    };
  }

  // -------------------------------------------------------------------------
  // Financials — three HTTP fetches in parallel; tolerant of any single failure
  // -------------------------------------------------------------------------

  protected async fetchFinancials(ticker: string, years: number): Promise<Financials> {
    const mapped = toStockAnalysisPath(ticker);
    if (!mapped) throw new TickerNotFoundError(this.name, ticker);

    const base = `${BASE}/quote/${mapped.exchange}/${mapped.symbol}/financials`;
    const [incomeHtml, balanceHtml, cashflowHtml] = await Promise.all([
      fetchHtml(`${base}/`),
      fetchHtml(`${base}/balance-sheet/`),
      fetchHtml(`${base}/cash-flow-statement/`),
    ]);

    if (!incomeHtml && !balanceHtml && !cashflowHtml) {
      throw new TickerNotFoundError(this.name, ticker);
    }

    const incomeStatements = incomeHtml ? this.parseIncome(incomeHtml, years) : [];
    const balanceSheets = balanceHtml ? this.parseBalance(balanceHtml, years) : [];
    const cashFlowStatements = cashflowHtml
      ? this.parseCashFlow(cashflowHtml, years)
      : [];

    // Patch shares outstanding from balance sheet into income statements
    // when the income page doesn't include the row (banks/finance companies).
    if (incomeStatements.length && balanceSheets.length) {
      for (let i = 0; i < incomeStatements.length; i++) {
        const inc = incomeStatements[i];
        const bal = balanceSheets[i];
        if ((!inc.sharesOutstanding || inc.sharesOutstanding === 0) && bal) {
          // Best-effort: derive from net income / EPS if both present
          if (inc.netIncome && inc.eps && inc.eps !== 0) {
            inc.sharesOutstanding = Math.abs(inc.netIncome / inc.eps);
          }
        }
        // Backfill book-value-per-share once we know the share count
        if (bal && inc.sharesOutstanding > 0 && !bal.bookValuePerShare) {
          bal.bookValuePerShare = bal.totalEquity / inc.sharesOutstanding;
        }
      }
    }

    return {
      ticker,
      incomeStatements,
      balanceSheets,
      cashFlowStatements,
      currency: 'INR',
      lastUpdated: new Date(),
    };
  }

  // ----- Parser helpers ---------------------------------------------------

  /**
   * stockanalysis reports most metrics in "millions" — for Indian companies
   * the page header notes "Financials in millions INR". We rescale to raw
   * rupees so the rest of the codebase (DCF, ratios) uses consistent units.
   *
   * The header phrasing has shifted historically ("in INR millions",
   * "Financials in millions INR", just "Millions INR") — match any of them.
   */
  private scaleForCurrency(html: string): number {
    if (/\b(millions?|in million)\b/i.test(html) && /\bINR\b/i.test(html)) return 1e6;
    if (/\b(billions?|in billion)\b/i.test(html) && /\bINR\b/i.test(html)) return 1e9;
    if (/\b(crores?)\b/i.test(html) && /\bINR\b/i.test(html)) return 1e7;
    if (/\b(thousands?)\b/i.test(html) && /\bINR\b/i.test(html)) return 1e3;
    return 1;
  }

  private parseIncome(html: string, years: number): IncomeStatement[] {
    const $ = cheerio.load(html);
    const fy = readFiscalYears($);
    const scale = this.scaleForCurrency(html);

    // Headline revenue: try several plausible labels — banks/NBFC pages call
    // it "Interest and Dividend Income" or "Revenue", insurers call it
    // "Total Revenue", manufacturers just "Revenue".
    const revenue =
      readRow($, /^Revenue$/i) ||
      readRow($, /Total Revenue/i) ||
      readRow($, /Net Interest Income/i) ||
      [];
    const cogs = readRow($, /Cost of (Revenue|Services|Goods)/i) || [];
    const gross = readRow($, /Gross Profit/i) || [];
    const operatingIncome = readRow($, /Operating Income/i) || [];
    const netIncome = readRow($, /^Net Income$/i) || readRow($, /Net Income/i) || [];
    const eps = readRow($, /EPS \(Diluted\)/i) || readRow($, /^EPS/i) || [];
    const ebitda = readRow($, /^EBITDA$/i) || [];
    const interest = readRow($, /Interest Expense/i) || [];
    const rd = readRow($, /Research & Development|R&D/i) || [];
    const sgna = readRow($, /Selling.*General.*Admin|SG&A/i) || [];

    const count = Math.min(years, fy.length || revenue.length || netIncome.length);
    const out: IncomeStatement[] = [];
    for (let i = 0; i < count; i++) {
      out.push({
        fiscalYear: fy[i] || String(new Date().getFullYear() - i),
        revenue: (revenue[i] || 0) * scale,
        costOfRevenue: (cogs[i] || 0) * scale,
        grossProfit: (gross[i] || (revenue[i] || 0) - (cogs[i] || 0)) * scale,
        researchAndDevelopment: rd[i] ? rd[i] * scale : null,
        sellingGeneralAdmin: sgna[i] ? sgna[i] * scale : null,
        operatingIncome: (operatingIncome[i] || 0) * scale,
        interestExpense: interest[i] ? interest[i] * scale : null,
        netIncome: (netIncome[i] || 0) * scale,
        eps: eps[i] || 0,
        epsDiluted: eps[i] || 0,
        ebitda: (ebitda[i] || operatingIncome[i] || 0) * scale,
        sharesOutstanding: 0, // filled later from balance sheet / derived
        reportDate: fy[i] || '',
      });
    }
    return out;
  }

  private parseBalance(html: string, years: number): BalanceSheet[] {
    const $ = cheerio.load(html);
    const fy = readFiscalYears($);
    const scale = this.scaleForCurrency(html);

    const totalAssets = readRow($, /Total Assets/i) || [];
    const currentAssets = readRow($, /Total Current Assets/i) || [];
    const cash = readRow($, /Cash.*Equivalents/i) || readRow($, /^Cash$/i) || [];
    const stInv = readRow($, /Short-Term Investments/i) || [];
    const inventory = readRow($, /^Inventory$/i) || [];
    const ar = readRow($, /Accounts Receivable/i) || [];
    const totalLiab = readRow($, /^Total Liabilities$/i) || readRow($, /Total Liabilities/i) || [];
    const currentLiab = readRow($, /Total Current Liabilities/i) || [];
    // stockanalysis breaks long-term debt into "Long-Term Debt" + "Current
    // Portion of Long-Term Debt" rows. For DCF / debt-to-equity we want them
    // both — they're already aggregated into "Total Debt".
    const totalDebt = readRow($, /^Total Debt$/i) || [];
    const longDebt = readRow($, /^Long-Term Debt$/i) || [];
    const shortDebt = readRow($, /^Short-Term Debt$/i) || [];
    // Equity rows: finance companies omit the "Total" prefix.
    const totalEquity =
      readRow($, /^(Total\s+)?(Shareholders'?|Stockholders'?)\s+Equity$/i) ||
      readRow($, /Total Equity/i) ||
      [];
    const retained = readRow($, /Retained Earnings/i) || [];
    // Shares are in millions on the page; matches the same scale as financials.
    const shares =
      readRow($, /^Total Common Shares Outstanding$/i) ||
      readRow($, /^Shares Outstanding$/i) ||
      [];
    // Book Value Per Share is provided directly — preferred over deriving.
    const bvps = readRow($, /^Book Value Per Share$/i) || [];

    const count = Math.min(years, fy.length || totalAssets.length);
    const out: BalanceSheet[] = [];
    for (let i = 0; i < count; i++) {
      out.push({
        fiscalYear: fy[i] || String(new Date().getFullYear() - i),
        totalAssets: (totalAssets[i] || 0) * scale,
        currentAssets: (currentAssets[i] || 0) * scale,
        cash: (cash[i] || 0) * scale,
        shortTermInvestments: stInv[i] ? stInv[i] * scale : null,
        accountsReceivable: ar[i] ? ar[i] * scale : null,
        inventory: inventory[i] ? inventory[i] * scale : null,
        totalLiabilities: (totalLiab[i] || 0) * scale,
        currentLiabilities: (currentLiab[i] || 0) * scale,
        longTermDebt: (longDebt[i] || 0) * scale,
        totalDebt: ((longDebt[i] || 0) + (shortDebt[i] || 0)) * scale,
        totalEquity: (totalEquity[i] || 0) * scale,
        retainedEarnings: retained[i] ? retained[i] * scale : null,
        bookValuePerShare: shares[i] && shares[i] > 0
          ? ((totalEquity[i] || 0) * scale) / (shares[i] * 1e6)
          : 0,
        reportDate: fy[i] || '',
      });
    }
    return out;
  }

  private parseCashFlow(html: string, years: number): CashFlowStatement[] {
    const $ = cheerio.load(html);
    const fy = readFiscalYears($);
    const scale = this.scaleForCurrency(html);

    const ni = readRow($, /Net Income/i) || [];
    const dep = readRow($, /Depreciation.*Amortization/i) || readRow($, /^Depreciation$/i) || [];
    const ocf =
      readRow($, /Operating Cash Flow/i) ||
      readRow($, /Cash from Operations/i) ||
      readRow($, /Net Cash from Operating/i) ||
      [];
    const capex =
      readRow($, /Capital Expenditure/i) ||
      readRow($, /Purchase of Property/i) ||
      [];
    const investingCf =
      readRow($, /Investing Cash Flow/i) ||
      readRow($, /Net Cash from Investing/i) ||
      [];
    const financingCf =
      readRow($, /Financing Cash Flow/i) ||
      readRow($, /Net Cash from Financing/i) ||
      [];
    const fcf = readRow($, /Free Cash Flow/i) || [];
    const div = readRow($, /Dividends? Paid/i) || [];
    const buyback = readRow($, /Repurchase of Common Stock|Stock Repurchase/i) || [];

    const count = Math.min(years, fy.length || ocf.length);
    const out: CashFlowStatement[] = [];
    for (let i = 0; i < count; i++) {
      const ocfV = (ocf[i] || 0) * scale;
      const capexV = Math.abs((capex[i] || 0) * scale);
      out.push({
        fiscalYear: fy[i] || String(new Date().getFullYear() - i),
        netIncome: (ni[i] || 0) * scale,
        depreciation: (dep[i] || 0) * scale,
        operatingCashFlow: ocfV,
        capitalExpenditure: capexV,
        investingCashFlow: (investingCf[i] || 0) * scale,
        financingCashFlow: (financingCf[i] || 0) * scale,
        freeCashFlow: fcf[i] ? fcf[i] * scale : ocfV - capexV,
        dividendsPaid: div[i] ? div[i] * scale : null,
        stockRepurchases: buyback[i] ? buyback[i] * scale : null,
        reportDate: fy[i] || '',
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Delegated to yahoo-direct
  // -------------------------------------------------------------------------

  async getHistoricalPrices(ticker: string, years = 5): Promise<HistoricalPrice[]> {
    return this.yahoo.getHistoricalPrices(ticker, years);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const html = await fetchHtml(`${BASE}/quote/nse/RELIANCE/`);
      return !!html && html.length > 5000;
    } catch {
      return false;
    }
  }
}
