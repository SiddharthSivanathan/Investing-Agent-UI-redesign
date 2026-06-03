/**
 * Finnhub Data Provider
 *
 * Uses the Finnhub API for financial data.
 * Free tier: 60 API calls per minute
 *
 * Get your free API key at: https://finnhub.io/register
 */

import { BaseProvider, ApiKeyError, TickerNotFoundError, RateLimitError } from './base.js';
import type {
  StockQuote,
  Financials,
  CompanyProfile,
  NewsItem,
  IncomeStatement,
  BalanceSheet,
  CashFlowStatement,
  ProviderConfig,
} from './types.js';

/**
 * Finnhub Provider
 *
 * Recommended alternative to Yahoo Finance with generous rate limits.
 */
export class FinnhubProvider extends BaseProvider {
  readonly name = 'finnhub';
  readonly displayName = 'Finnhub';
  readonly requiresApiKey = true;

  private apiKey: string;
  private baseUrl = 'https://finnhub.io/api/v1';

  constructor(config?: ProviderConfig) {
    super(config);

    this.apiKey = config?.apiKey || process.env.FINNHUB_API_KEY || '';

    if (!this.apiKey) {
      throw new ApiKeyError(this.name);
    }
  }

  /**
   * Make API request
   */
  private async request<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.append('token', this.apiKey);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }

    const response = await fetch(url.toString());

    if (response.status === 429) {
      throw new RateLimitError(this.name);
    }

    if (response.status === 401) {
      throw new ApiKeyError(this.name);
    }

    if (!response.ok) {
      throw new Error(`Finnhub API error: ${response.status}`);
    }

    const text = await response.text();

try {
  return JSON.parse(text) as T;
} catch (err) {
  console.error('Finnhub raw response:', text);
  throw new Error(
    `Finnhub returned non-JSON response. Status=${response.status}. Body=${text.substring(0, 300)}`
  );
}
  }

  /**
   * Fetch real-time stock quote
   */
  protected async fetchQuote(ticker: string): Promise<StockQuote> {
    // Get quote data
    const [quoteData, profileData, metricsData] = await Promise.all([
      this.request<{
        c: number;  // Current price
        d: number;  // Change
        dp: number; // Percent change
        h: number;  // High
        l: number;  // Low
        o: number;  // Open
        pc: number; // Previous close
        t: number;  // Timestamp
      }>('/quote', { symbol: ticker }),
      this.request<{
        name: string;
        ticker: string;
        exchange: string;
        currency: string;
        marketCapitalization: number;
        shareOutstanding: number;
      }>('/stock/profile2', { symbol: ticker }),
      this.request<{
        metric: {
          '52WeekHigh': number;
          '52WeekLow': number;
          peBasicExclExtraTTM: number;
          pbAnnual: number;
          psAnnual: number;
          dividendYieldIndicatedAnnual: number;
        };
      }>('/stock/metric', { symbol: ticker, metric: 'all' }),
    ]);

    if (!quoteData.c || quoteData.c === 0) {
      throw new TickerNotFoundError(this.name, ticker);
    }

    const metrics = metricsData.metric || {};

    return {
      ticker: profileData.ticker || ticker,
      name: profileData.name || ticker,
      price: quoteData.c,
      open: quoteData.o,
      high: quoteData.h,
      low: quoteData.l,
      previousClose: quoteData.pc,
      change: quoteData.d,
      changePercent: quoteData.dp,
      volume: 0, // Not available in basic quote
      marketCap: (profileData.marketCapitalization || 0) * 1_000_000, // Finnhub returns in millions
      pe: metrics['peBasicExclExtraTTM'] ?? null,
      pb: metrics['pbAnnual'] ?? null,
      ps: metrics['psAnnual'] ?? null,
      dividendYield: metrics['dividendYieldIndicatedAnnual']
        ? metrics['dividendYieldIndicatedAnnual'] / 100
        : null,
      week52High: metrics['52WeekHigh'] || quoteData.c,
      week52Low: metrics['52WeekLow'] || quoteData.c,
      timestamp: new Date(quoteData.t * 1000),
      currency: profileData.currency || 'USD',
      exchange: profileData.exchange || 'UNKNOWN',
    };
  }

  /**
   * Fetch financial statements
   *
   * Strategy:
   *   1. Pull `/stock/financials-reported` which returns the actual 10-K filings
   *      (SEC XBRL concept/value pairs). This is the only Finnhub endpoint
   *      that has the full statement detail.
   *   2. Cross-reference each year with `/stock/metric` series for fallback
   *      values (EPS, book value, FCF) when concepts are missing.
   *   3. Map each statement using a list of likely US-GAAP concept names.
   */
  protected async fetchFinancials(ticker: string, years: number): Promise<Financials> {
    type Concept = { concept?: string; label?: string; unit?: string; value?: number };
    type ReportedFiling = {
      year?: number;
      quarter?: number;
      form?: string;
      startDate?: string;
      endDate?: string;
      report?: {
        ic?: Concept[];
        bs?: Concept[];
        cf?: Concept[];
      };
    };

    const [filingsData, basicFinancials] = await Promise.all([
      this.request<{ data?: ReportedFiling[] }>('/stock/financials-reported', {
        symbol: ticker,
        freq: 'annual',
      }).catch(() => ({ data: [] as ReportedFiling[] })),
      this.request<{
        metric: Record<string, number>;
        series: {
          annual: Record<string, Array<{ period: string; v: number }>>;
        };
      }>('/stock/metric', { symbol: ticker, metric: 'all' }).catch(() => ({
        metric: {} as Record<string, number>,
        series: { annual: {} } as { annual: Record<string, Array<{ period: string; v: number }>> },
      })),
    ]);

    const annualFilings = (filingsData.data || [])
      .filter((f) => (f.form ?? '').includes('10-K') || (f.quarter ?? 0) === 0)
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
      .slice(0, years);

    const metric = basicFinancials.metric || {};
    const seriesAnnual = basicFinancials.series?.annual || {};

    const series = (key: string, year: string): number | null => {
      const arr = seriesAnnual[key] || [];
      const hit = arr.find((p) => p.period?.startsWith(year));
      return typeof hit?.v === 'number' ? hit.v : null;
    };

    // Find a concept in a report section, trying multiple US-GAAP names.
    const find = (section: Concept[] | undefined, names: string[]): number => {
      if (!section?.length) return 0;
      for (const name of names) {
        const lower = name.toLowerCase();
        const hit = section.find((c) => (c.concept || '').toLowerCase().endsWith(lower));
        if (hit && typeof hit.value === 'number') return hit.value;
      }
      // Loose match on label
      for (const name of names) {
        const hit = section.find((c) =>
          (c.label || '').toLowerCase().includes(name.toLowerCase())
        );
        if (hit && typeof hit.value === 'number') return hit.value;
      }
      return 0;
    };

    const incomeStatements: IncomeStatement[] = [];
    const balanceSheets: BalanceSheet[] = [];
    const cashFlowStatements: CashFlowStatement[] = [];

    // Build per-year statements from the actual filings
    for (const f of annualFilings) {
      const year = String(f.year ?? (f.endDate || '').slice(0, 4));
      const ic = f.report?.ic;
      const bs = f.report?.bs;
      const cf = f.report?.cf;

      const revenue = find(ic, ['Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerExcludingAssessedTax']);
      const costOfRevenue = find(ic, ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold']);
      const grossProfit = find(ic, ['GrossProfit']) || (revenue - costOfRevenue);
      const operatingIncome = find(ic, ['OperatingIncomeLoss', 'OperatingIncome']);
      const netIncome = find(ic, ['NetIncomeLoss', 'NetIncome', 'ProfitLoss']);
      const eps = find(ic, [
        'EarningsPerShareDiluted',
        'EarningsPerShareBasic',
        'IncomeLossFromContinuingOperationsPerDilutedShare',
      ]) || series('epsBasicExclExtraItemsAnnual', year) || 0;
      const sharesOutstanding =
        find(ic, [
          'WeightedAverageNumberOfDilutedSharesOutstanding',
          'WeightedAverageNumberOfSharesOutstandingBasic',
          'CommonStockSharesOutstanding',
        ]) || (netIncome > 0 && eps > 0 ? netIncome / eps : 0);
      const ebitda = find(ic, ['Ebitda', 'EarningsBeforeInterestTaxesDepreciationAndAmortization']);

      incomeStatements.push({
        fiscalYear: year,
        revenue,
        costOfRevenue,
        grossProfit,
        researchAndDevelopment: find(ic, ['ResearchAndDevelopmentExpense']) || null,
        sellingGeneralAdmin: find(ic, ['SellingGeneralAndAdministrativeExpense']) || null,
        operatingIncome,
        interestExpense: find(ic, ['InterestExpense', 'InterestExpenseDebt']) || null,
        netIncome,
        eps,
        epsDiluted: find(ic, ['EarningsPerShareDiluted']) || eps,
        ebitda: ebitda || operatingIncome,
        sharesOutstanding,
        reportDate: f.endDate || year,
      });

      const totalAssets = find(bs, ['Assets']);
      const currentAssets = find(bs, ['AssetsCurrent']);
      const cash = find(bs, [
        'CashAndCashEquivalentsAtCarryingValue',
        'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
      ]);
      const totalLiabilities = find(bs, ['Liabilities']);
      const currentLiabilities = find(bs, ['LiabilitiesCurrent']);
      const longTermDebt = find(bs, ['LongTermDebtNoncurrent', 'LongTermDebt']);
      const shortTermDebt = find(bs, ['LongTermDebtCurrent', 'ShortTermBorrowings']);
      const totalEquity = find(bs, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']);
      const bookValuePerShare = sharesOutstanding > 0 ? totalEquity / sharesOutstanding : 0;

      balanceSheets.push({
        fiscalYear: year,
        totalAssets,
        currentAssets,
        cash,
        shortTermInvestments: find(bs, ['ShortTermInvestments']) || null,
        accountsReceivable: find(bs, ['AccountsReceivableNetCurrent']) || null,
        inventory: find(bs, ['InventoryNet']) || null,
        totalLiabilities,
        currentLiabilities,
        longTermDebt,
        totalDebt: longTermDebt + shortTermDebt,
        totalEquity,
        retainedEarnings: find(bs, ['RetainedEarningsAccumulatedDeficit']) || null,
        bookValuePerShare,
        reportDate: f.endDate || year,
      });

      const operatingCashFlow = find(cf, [
        'NetCashProvidedByUsedInOperatingActivities',
        'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
      ]);
      const capex = Math.abs(find(cf, [
        'PaymentsToAcquirePropertyPlantAndEquipment',
        'PaymentsForCapitalImprovements',
      ]));
      const depreciation = find(cf, [
        'DepreciationDepletionAndAmortization',
        'DepreciationAndAmortization',
        'Depreciation',
      ]);

      cashFlowStatements.push({
        fiscalYear: year,
        netIncome: find(cf, ['NetIncomeLoss', 'ProfitLoss']) || netIncome,
        depreciation,
        operatingCashFlow,
        capitalExpenditure: capex,
        investingCashFlow: find(cf, ['NetCashProvidedByUsedInInvestingActivities']),
        financingCashFlow: find(cf, ['NetCashProvidedByUsedInFinancingActivities']),
        freeCashFlow: operatingCashFlow - capex,
        dividendsPaid: find(cf, ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock']) || null,
        stockRepurchases: find(cf, ['PaymentsForRepurchaseOfCommonStock']) || null,
        reportDate: f.endDate || year,
      });
    }

    // Fallback path: if filings endpoint returned nothing (Finnhub free-tier
    // restriction for some symbols), seed from the series data so the UI still
    // shows *something* instead of blank zeros.
    if (incomeStatements.length === 0) {
      const epsData = seriesAnnual['epsBasicExclExtraItemsAnnual'] || [];
      const revenueData =
        seriesAnnual['salesPerShareAnnual'] || seriesAnnual['revenuePerShareAnnual'] || [];
      for (let i = 0; i < Math.min(years, epsData.length || revenueData.length); i++) {
        const year = (epsData[i]?.period || revenueData[i]?.period || '').slice(0, 4);
        incomeStatements.push({
          fiscalYear: year,
          revenue: 0,
          costOfRevenue: 0,
          grossProfit: 0,
          researchAndDevelopment: null,
          sellingGeneralAdmin: null,
          operatingIncome: 0,
          interestExpense: null,
          netIncome: 0,
          eps: epsData[i]?.v || 0,
          epsDiluted: epsData[i]?.v || 0,
          ebitda: 0,
          sharesOutstanding: 0,
          reportDate: year,
        });
        balanceSheets.push({
          fiscalYear: year,
          totalAssets: 0,
          currentAssets: 0,
          cash: 0,
          shortTermInvestments: null,
          accountsReceivable: null,
          inventory: null,
          totalLiabilities: 0,
          currentLiabilities: 0,
          longTermDebt: 0,
          totalDebt: 0,
          totalEquity: 0,
          retainedEarnings: null,
          bookValuePerShare: metric['bookValuePerShareAnnual'] || 0,
          reportDate: year,
        });
        cashFlowStatements.push({
          fiscalYear: year,
          netIncome: 0,
          depreciation: 0,
          operatingCashFlow: 0,
          capitalExpenditure: 0,
          investingCashFlow: 0,
          financingCashFlow: 0,
          freeCashFlow: 0,
          dividendsPaid: null,
          stockRepurchases: null,
          reportDate: year,
        });
      }
    }

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
   * Fetch company profile
   */
  protected async fetchCompanyProfile(ticker: string): Promise<CompanyProfile> {
    const profile = await this.request<{
      name: string;
      ticker: string;
      country: string;
      currency: string;
      exchange: string;
      finnhubIndustry: string;
      weburl: string;
      logo: string;
      employeeTotal: number;
    }>('/stock/profile2', { symbol: ticker });

    if (!profile.name) {
      throw new TickerNotFoundError(this.name, ticker);
    }

    return {
      ticker: profile.ticker || ticker,
      name: profile.name,
      description: '', // Not provided by Finnhub basic endpoint
      sector: profile.finnhubIndustry || 'Unknown',
      industry: profile.finnhubIndustry || 'Unknown',
      employees: profile.employeeTotal || null,
      website: profile.weburl || '',
      country: profile.country || 'Unknown',
    };
  }

  /**
   * Get news
   */
  async getNews(ticker: string, days = 7): Promise<NewsItem[]> {
    const toDate = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    const news = await this.request<
      Array<{
        headline: string;
        source: string;
        url: string;
        datetime: number;
        summary: string;
        related: string;
      }>
    >('/company-news', {
      symbol: ticker,
      from: fromDate,
      to: toDate,
    });

    return news.map((item) => ({
      title: item.headline,
      source: item.source,
      url: item.url,
      publishedAt: new Date(item.datetime * 1000),
      summary: item.summary,
      relatedTickers: item.related?.split(','),
    }));
  }

  /**
   * Search stocks
   */
  async searchStocks(
    query: string
  ): Promise<Array<{ ticker: string; name: string; exchange: string }>> {
    const results = await this.request<{
      result: Array<{
        symbol: string;
        description: string;
        type: string;
        displaySymbol: string;
      }>;
    }>('/search', { q: query });

    return (results.result || [])
      .filter((r) => r.type === 'Common Stock')
      .slice(0, 10)
      .map((r) => ({
        ticker: r.symbol,
        name: r.description,
        exchange: '',
      }));
  }
}
