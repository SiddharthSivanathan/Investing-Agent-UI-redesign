/**
 * Yahoo Direct Provider
 *
 * Uses Yahoo Finance's lightweight `/v8/finance/chart/` endpoint directly.
 * This endpoint isn't rate-limited the same way the `quoteSummary` API is
 * (which the `yahoo-finance2` package depends on), so it works reliably for
 * Indian (.NS / .BO) and other non-US tickers even when the main provider
 * is throttled.
 *
 * Trade-off: this endpoint doesn't return financial statements, so the DCF
 * and full ratio analysis won't run — but the quote, KPIs, and price chart
 * all populate, which is the most-used part of the UI.
 */

import { BaseProvider, TickerNotFoundError } from './base.js';
import type {
  StockQuote,
  Financials,
  CompanyProfile,
  HistoricalPrice,
  ProviderConfig,
} from './types.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

interface ChartMeta {
  currency: string;
  symbol: string;
  exchangeName: string;
  fullExchangeName: string;
  instrumentType: string;
  regularMarketPrice: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  regularMarketDayHigh: number;
  regularMarketDayLow: number;
  regularMarketVolume: number;
  chartPreviousClose: number;
  previousClose?: number;
  longName?: string;
  shortName?: string;
}

interface ChartResponse {
  chart: {
    result: Array<{
      meta: ChartMeta;
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: number[];
          high?: number[];
          low?: number[];
          close?: number[];
          volume?: number[];
        }>;
        adjclose?: Array<{ adjclose?: number[] }>;
      };
    }> | null;
    error?: { code: string; description: string } | null;
  };
}

export class YahooDirectProvider extends BaseProvider {
  readonly name = 'yahoo-direct';
  readonly displayName = 'Yahoo Direct (light)';
  readonly requiresApiKey = false;

  constructor(config?: ProviderConfig) {
    super(config);
  }

  private async fetchChart(
    ticker: string,
    range: string = '1d',
    interval: string = '1d'
  ): Promise<ChartResponse> {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/` +
      `${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      if (res.status === 429) throw new Error('Yahoo rate-limited the chart endpoint');
      if (res.status === 404) throw new TickerNotFoundError(this.name, ticker);
      throw new Error(`Yahoo chart error: ${res.status}`);
    }
    return (await res.json()) as ChartResponse;
  }

  protected async fetchQuote(ticker: string): Promise<StockQuote> {
    const data = await this.fetchChart(ticker, '5d', '1d');
    const result = data.chart.result?.[0];
    if (!result?.meta) throw new TickerNotFoundError(this.name, ticker);

    const m = result.meta;
    const price = m.regularMarketPrice;
    const prev = m.previousClose ?? m.chartPreviousClose ?? price;
    const change = price - prev;
    const changePercent = prev > 0 ? (change / prev) * 100 : 0;

    return {
      ticker: m.symbol || ticker,
      name: m.longName || m.shortName || m.symbol || ticker,
      price,
      open: result.indicators?.quote?.[0]?.open?.slice(-1)[0] ?? price,
      high: m.regularMarketDayHigh ?? price,
      low: m.regularMarketDayLow ?? price,
      previousClose: prev,
      change,
      changePercent,
      volume: m.regularMarketVolume ?? 0,
      marketCap: 0, // not available from chart endpoint
      pe: null,
      pb: null,
      ps: null,
      dividendYield: null,
      week52High: m.fiftyTwoWeekHigh ?? price,
      week52Low: m.fiftyTwoWeekLow ?? price,
      timestamp: new Date(),
      currency: m.currency || 'USD',
      exchange: m.fullExchangeName || m.exchangeName || 'UNKNOWN',
    };
  }

  /**
   * No financial statements available — returns empty arrays so the UI shows
   * the quote + chart while gracefully skipping the DCF/ratio sections.
   */
  protected async fetchFinancials(ticker: string): Promise<Financials> {
    return {
      ticker,
      incomeStatements: [],
      balanceSheets: [],
      cashFlowStatements: [],
      currency: 'INR',
      lastUpdated: new Date(),
    };
  }

  protected async fetchCompanyProfile(ticker: string): Promise<CompanyProfile> {
    const data = await this.fetchChart(ticker, '1d', '1d');
    const m = data.chart.result?.[0]?.meta;
    if (!m) throw new TickerNotFoundError(this.name, ticker);
    return {
      ticker: m.symbol || ticker,
      name: m.longName || m.shortName || m.symbol || ticker,
      description: '',
      sector: 'Unknown',
      industry: 'Unknown',
      employees: null,
      website: '',
      country:
        m.fullExchangeName?.toLowerCase().includes('nse') ||
        m.fullExchangeName?.toLowerCase().includes('bse')
          ? 'India'
          : 'Unknown',
    };
  }

  async getHistoricalPrices(ticker: string, years = 5): Promise<HistoricalPrice[]> {
    const range = years <= 1 ? '1y' : years <= 2 ? '2y' : years <= 5 ? '5y' : '10y';
    const data = await this.fetchChart(ticker, range, '1d');
    const result = data.chart.result?.[0];
    if (!result?.timestamp) return [];

    const ts = result.timestamp;
    const q = result.indicators?.quote?.[0];
    const adj = result.indicators?.adjclose?.[0]?.adjclose;

    const out: HistoricalPrice[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q?.close?.[i];
      if (close == null) continue;
      out.push({
        date: new Date(ts[i] * 1000),
        open: q?.open?.[i] ?? close,
        high: q?.high?.[i] ?? close,
        low: q?.low?.[i] ?? close,
        close,
        volume: q?.volume?.[i] ?? 0,
        adjustedClose: adj?.[i] ?? close,
      });
    }
    return out;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.fetchChart('AAPL', '1d', '1d');
      return true;
    } catch {
      return false;
    }
  }
}
