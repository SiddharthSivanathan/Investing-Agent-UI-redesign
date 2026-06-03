/**
 * Yahoo Finance Data Provider
 *
 * Default data provider using the yahoo-finance2 npm package.
 * Free to use, no API key required.
 *
 * @see https://www.npmjs.com/package/yahoo-finance2
 */

import YahooFinance from 'yahoo-finance2';
import { BaseProvider, TickerNotFoundError } from './base.js';

// yahoo-finance2 v2.14+ exports a class by default; older versions export a singleton.
// Support both shapes transparently.
const yahooFinance: any =
  typeof (YahooFinance as any) === 'function' &&
  typeof (YahooFinance as any).prototype?.quote === 'function'
    ? new (YahooFinance as any)()
    : YahooFinance;
import type {
  StockQuote,
  Financials,
  CompanyProfile,
  HistoricalPrice,
  IncomeStatement,
  BalanceSheet,
  CashFlowStatement,
  ProviderConfig,
} from './types.js';

// Suppress yahoo-finance2 validation warnings in production (best-effort across versions)
try {
  (yahooFinance as unknown as { suppressNotices?: (n: string[]) => void }).suppressNotices?.([
    'yahooSurvey',
    'ripHistorical',
  ]);
} catch {
  // ignore: older versions don't expose this method
}

/**
 * Yahoo Finance Provider
 *
 * Uses yahoo-finance2 package to fetch stock data.
 * Note: Yahoo Finance has rate limits, use caching in production.
 */
export class YahooFinanceProvider extends BaseProvider {
  readonly name = 'yahoo-finance';
  readonly displayName = 'Yahoo Finance';
  readonly requiresApiKey = false;

  constructor(config?: ProviderConfig) {
    super(config);
  }

  /**
   * Fetch real-time stock quote
   */
  protected async fetchQuote(ticker: string): Promise<StockQuote> {
    const quote = await yahooFinance.quote(ticker);

    if (!quote || !quote.regularMarketPrice) {
      throw new TickerNotFoundError(this.name, ticker);
    }

    return {
      ticker: quote.symbol || ticker,
      name: quote.shortName || quote.longName || ticker,
      price: quote.regularMarketPrice,
      open: quote.regularMarketOpen || quote.regularMarketPrice,
      high: quote.regularMarketDayHigh || quote.regularMarketPrice,
      low: quote.regularMarketDayLow || quote.regularMarketPrice,
      previousClose: quote.regularMarketPreviousClose || quote.regularMarketPrice,
      change: quote.regularMarketChange || 0,
      changePercent: quote.regularMarketChangePercent || 0,
      volume: quote.regularMarketVolume || 0,
      marketCap: quote.marketCap || 0,
      pe: quote.trailingPE ?? null,
      pb: quote.priceToBook ?? null,
      ps: quote.priceToSalesTrailing12Months ?? null,
      dividendYield: quote.trailingAnnualDividendYield ?? null,
      week52High: quote.fiftyTwoWeekHigh || quote.regularMarketPrice,
      week52Low: quote.fiftyTwoWeekLow || quote.regularMarketPrice,
      timestamp: new Date(),
      currency: quote.currency || 'USD',
      exchange: quote.exchange || 'UNKNOWN',
    };
  }

  /**
   * Fetch financial statements
   */
  protected async fetchFinancials(ticker: string, years: number): Promise<Financials> {
    // Fetch all financial data in parallel
    const [quoteSummary] = await Promise.all([
      yahooFinance.quoteSummary(ticker, {
        modules: [
          'incomeStatementHistory',
          'incomeStatementHistoryQuarterly',
          'balanceSheetHistory',
          'balanceSheetHistoryQuarterly',
          'cashflowStatementHistory',
          'cashflowStatementHistoryQuarterly',
          'defaultKeyStatistics',
          'financialData',
        ],
      }),
    ]);

    if (!quoteSummary) {
      throw new TickerNotFoundError(this.name, ticker);
    }

    const incomeStatements = this.parseIncomeStatements(
      quoteSummary.incomeStatementHistory?.incomeStatementHistory || [],
      years
    );

    const balanceSheets = this.parseBalanceSheets(
      quoteSummary.balanceSheetHistory?.balanceSheetStatements || [],
      years
    );

    const cashFlowStatements = this.parseCashFlowStatements(
      quoteSummary.cashflowStatementHistory?.cashflowStatements || [],
      years
    );

    return {
      ticker,
      incomeStatements,
      balanceSheets,
      cashFlowStatements,
      currency: 'USD',
      lastUpdated: new Date(),
    };
  }

  /**
   * Parse income statements from Yahoo Finance data
   */
  private parseIncomeStatements(
    statements: Array<Record<string, unknown>>,
    years: number
  ): IncomeStatement[] {
    return statements.slice(0, years).map((stmt) => {
      const endDate = stmt.endDate as { fmt?: string } | undefined;
      const fiscalYear = endDate?.fmt?.slice(0, 4) || 'Unknown';

      return {
        fiscalYear,
        revenue: this.getNumber(stmt.totalRevenue),
        costOfRevenue: this.getNumber(stmt.costOfRevenue),
        grossProfit: this.getNumber(stmt.grossProfit),
        researchAndDevelopment: this.getNumberOrNull(stmt.researchDevelopment),
        sellingGeneralAdmin: this.getNumberOrNull(stmt.sellingGeneralAdministrative),
        operatingIncome: this.getNumber(stmt.operatingIncome),
        interestExpense: this.getNumberOrNull(stmt.interestExpense),
        netIncome: this.getNumber(stmt.netIncome),
        eps: this.getNumber(stmt.dilutedEPS || stmt.basicEPS),
        epsDiluted: this.getNumber(stmt.dilutedEPS),
        ebitda: this.getNumber(stmt.ebitda),
        sharesOutstanding: this.getNumber(stmt.dilutedAverageShares || stmt.basicAverageShares),
        reportDate: endDate?.fmt || '',
      };
    });
  }

  /**
   * Parse balance sheets from Yahoo Finance data
   */
  private parseBalanceSheets(
    statements: Array<Record<string, unknown>>,
    years: number
  ): BalanceSheet[] {
    return statements.slice(0, years).map((stmt) => {
      const endDate = stmt.endDate as { fmt?: string } | undefined;
      const fiscalYear = endDate?.fmt?.slice(0, 4) || 'Unknown';

      const totalEquity = this.getNumber(stmt.totalStockholderEquity);
      const sharesOutstanding = this.getNumber(stmt.commonStock) || 1;

      return {
        fiscalYear,
        totalAssets: this.getNumber(stmt.totalAssets),
        currentAssets: this.getNumber(stmt.totalCurrentAssets),
        cash: this.getNumber(stmt.cash),
        shortTermInvestments: this.getNumberOrNull(stmt.shortTermInvestments),
        accountsReceivable: this.getNumberOrNull(stmt.netReceivables),
        inventory: this.getNumberOrNull(stmt.inventory),
        totalLiabilities: this.getNumber(stmt.totalLiab),
        currentLiabilities: this.getNumber(stmt.totalCurrentLiabilities),
        longTermDebt: this.getNumber(stmt.longTermDebt),
        totalDebt: this.getNumber(stmt.longTermDebt) + this.getNumber(stmt.shortLongTermDebt),
        totalEquity,
        retainedEarnings: this.getNumberOrNull(stmt.retainedEarnings),
        bookValuePerShare: totalEquity / (sharesOutstanding || 1),
        reportDate: endDate?.fmt || '',
      };
    });
  }

  /**
   * Parse cash flow statements from Yahoo Finance data
   */
  private parseCashFlowStatements(
    statements: Array<Record<string, unknown>>,
    years: number
  ): CashFlowStatement[] {
    return statements.slice(0, years).map((stmt) => {
      const endDate = stmt.endDate as { fmt?: string } | undefined;
      const fiscalYear = endDate?.fmt?.slice(0, 4) || 'Unknown';

      const operatingCashFlow = this.getNumber(stmt.totalCashFromOperatingActivities);
      const capitalExpenditure = Math.abs(this.getNumber(stmt.capitalExpenditures));

      return {
        fiscalYear,
        netIncome: this.getNumber(stmt.netIncome),
        depreciation: this.getNumber(stmt.depreciation),
        operatingCashFlow,
        capitalExpenditure,
        investingCashFlow: this.getNumber(stmt.totalCashflowsFromInvestingActivities),
        financingCashFlow: this.getNumber(stmt.totalCashFromFinancingActivities),
        freeCashFlow: operatingCashFlow - capitalExpenditure,
        dividendsPaid: this.getNumberOrNull(stmt.dividendsPaid),
        stockRepurchases: this.getNumberOrNull(stmt.repurchaseOfStock),
        reportDate: endDate?.fmt || '',
      };
    });
  }

  /**
   * Fetch company profile
   */
  protected async fetchCompanyProfile(ticker: string): Promise<CompanyProfile> {
    const quoteSummary = await yahooFinance.quoteSummary(ticker, {
      modules: ['assetProfile', 'summaryProfile', 'price'],
    });

    if (!quoteSummary) {
      throw new TickerNotFoundError(this.name, ticker);
    }

    const profile = quoteSummary.assetProfile || quoteSummary.summaryProfile;
    const price = quoteSummary.price;

    return {
      ticker,
      name: price?.shortName || price?.longName || ticker,
      description: (profile as Record<string, unknown>)?.longBusinessSummary as string || '',
      sector: (profile as Record<string, unknown>)?.sector as string || 'Unknown',
      industry: (profile as Record<string, unknown>)?.industry as string || 'Unknown',
      employees: (profile as Record<string, unknown>)?.fullTimeEmployees as number || null,
      website: (profile as Record<string, unknown>)?.website as string || '',
      country: (profile as Record<string, unknown>)?.country as string || 'Unknown',
      ceo: ((profile as Record<string, unknown>)?.companyOfficers as Array<{ title?: string; name?: string }>)?.find(
        (o) => o.title?.toLowerCase().includes('ceo')
      )?.name,
    };
  }

  /**
   * Fetch historical prices
   */
  async getHistoricalPrices(ticker: string, years = 5): Promise<HistoricalPrice[]> {
    const normalizedTicker = this.normalizeTicker(ticker);

    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - years);

    const result = await yahooFinance.chart(normalizedTicker, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    if (!result || !result.quotes) {
      throw new TickerNotFoundError(this.name, normalizedTicker);
    }

    return result.quotes
      .filter((q) => q.close !== null)
      .map((q) => ({
        date: new Date(q.date),
        open: q.open || q.close || 0,
        high: q.high || q.close || 0,
        low: q.low || q.close || 0,
        close: q.close || 0,
        volume: q.volume || 0,
        adjustedClose: q.adjclose || q.close || 0,
      }));
  }

  /**
   * Search for stocks
   */
  async searchStocks(query: string): Promise<Array<{ ticker: string; name: string; exchange: string }>> {
    const result = await yahooFinance.search(query);

    return (result.quotes || [])
      .filter((q) => q.quoteType === 'EQUITY')
      .map((q) => ({
        ticker: q.symbol,
        name: q.shortname || q.longname || q.symbol,
        exchange: q.exchange || 'UNKNOWN',
      }));
  }

  /**
   * Helper to safely get number from unknown value
   */
  private getNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'object' && value !== null && 'raw' in value) {
      return (value as { raw: number }).raw || 0;
    }
    return 0;
  }

  /**
   * Helper to safely get number or null
   */
  private getNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const num = this.getNumber(value);
    return num === 0 ? null : num;
  }
}
