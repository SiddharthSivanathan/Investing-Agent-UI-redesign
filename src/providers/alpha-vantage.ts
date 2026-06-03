/**
 * Alpha Vantage Data Provider
 *
 * Uses the Alpha Vantage API for financial data.
 * Requires a free API key from: https://www.alphavantage.co/support/#api-key
 *
 * Rate limits:
 * - Free tier: 5 API requests per minute, 500 per day
 * - Premium tiers available for higher limits
 */

import { BaseProvider, ApiKeyError, TickerNotFoundError, RateLimitError } from './base.js';
import type {
  StockQuote,
  Financials,
  CompanyProfile,
  IncomeStatement,
  BalanceSheet,
  CashFlowStatement,
  ProviderConfig,
} from './types.js';

/**
 * Alpha Vantage Provider
 *
 * Note: This is an example implementation. Alpha Vantage API
 * responses may vary and this code should be tested thoroughly.
 */
export class AlphaVantageProvider extends BaseProvider {
  readonly name = 'alpha-vantage';
  readonly displayName = 'Alpha Vantage';
  readonly requiresApiKey = true;

  private apiKey: string;
  private baseUrl = 'https://www.alphavantage.co/query';

  constructor(config?: ProviderConfig) {
    super(config);

    this.apiKey = config?.apiKey || process.env.ALPHA_VANTAGE_API_KEY || '';

    if (!this.apiKey) {
      throw new ApiKeyError(this.name);
    }
  }

  /**
   * Make API request with error handling
   */
  private async makeRequest<T>(params: Record<string, string>): Promise<T> {
    const url = new URL(this.baseUrl);
    url.searchParams.append('apikey', this.apiKey);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      if (response.status === 429) {
        throw new RateLimitError(this.name);
      }
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json() as T & {
      Note?: string;
      Information?: string;
      'Error Message'?: string;
    };

    // Rate-limit / quota signals (Alpha Vantage uses several shapes)
    const limitText = [data.Note, data.Information].filter(Boolean).join(' ');
    if (/API call frequency|rate limit|requests per (?:day|minute)/i.test(limitText)) {
      throw new RateLimitError(this.name);
    }

    // Explicit error
    if (data['Error Message']) {
      throw new Error(data['Error Message']);
    }

    // Standalone Information payload (free-tier notice) → treat as rate-limit
    // so we don't misclassify as "ticker not found".
    if (data.Information && Object.keys(data as object).length <= 2) {
      throw new RateLimitError(this.name);
    }

    return data;
  }

  /**
   * Fetch real-time stock quote
   */
  protected async fetchQuote(ticker: string): Promise<StockQuote> {
    // Get global quote
    const quoteData = await this.makeRequest<{
      'Global Quote': Record<string, string>;
    }>({
      function: 'GLOBAL_QUOTE',
      symbol: ticker,
    });

    const quote = quoteData['Global Quote'];

    if (!quote || Object.keys(quote).length === 0) {
      throw new TickerNotFoundError(this.name, ticker);
    }

    // Get overview for additional metrics
    const overview = await this.makeRequest<Record<string, string>>({
      function: 'OVERVIEW',
      symbol: ticker,
    });

    const price = parseFloat(quote['05. price']) || 0;
    const previousClose = parseFloat(quote['08. previous close']) || price;

    return {
      ticker: quote['01. symbol'] || ticker,
      name: overview['Name'] || ticker,
      price,
      open: parseFloat(quote['02. open']) || price,
      high: parseFloat(quote['03. high']) || price,
      low: parseFloat(quote['04. low']) || price,
      previousClose,
      change: parseFloat(quote['09. change']) || 0,
      changePercent: parseFloat(quote['10. change percent']?.replace('%', '')) || 0,
      volume: parseInt(quote['06. volume']) || 0,
      marketCap: parseFloat(overview['MarketCapitalization']) || 0,
      pe: this.parseNumberOrNull(overview['PERatio']),
      pb: this.parseNumberOrNull(overview['PriceToBookRatio']),
      ps: this.parseNumberOrNull(overview['PriceToSalesRatioTTM']),
      dividendYield: this.parseNumberOrNull(overview['DividendYield']),
      week52High: parseFloat(overview['52WeekHigh']) || price,
      week52Low: parseFloat(overview['52WeekLow']) || price,
      timestamp: new Date(),
      currency: overview['Currency'] || 'USD',
      exchange: overview['Exchange'] || 'UNKNOWN',
    };
  }

  /**
   * Fetch financial statements
   */
  protected async fetchFinancials(ticker: string, years: number): Promise<Financials> {
    // Fetch all financial data in parallel
    const [incomeData, balanceData, cashFlowData] = await Promise.all([
      this.makeRequest<{ annualReports: Record<string, string>[] }>({
        function: 'INCOME_STATEMENT',
        symbol: ticker,
      }),
      this.makeRequest<{ annualReports: Record<string, string>[] }>({
        function: 'BALANCE_SHEET',
        symbol: ticker,
      }),
      this.makeRequest<{ annualReports: Record<string, string>[] }>({
        function: 'CASH_FLOW',
        symbol: ticker,
      }),
    ]);

    const incomeStatements = this.parseIncomeStatements(
      incomeData.annualReports || [],
      years
    );
    const balanceSheets = this.parseBalanceSheets(
      balanceData.annualReports || [],
      years
    );
    const cashFlowStatements = this.parseCashFlowStatements(
      cashFlowData.annualReports || [],
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
   * Parse income statements
   */
  private parseIncomeStatements(
    reports: Record<string, string>[],
    years: number
  ): IncomeStatement[] {
    return reports.slice(0, years).map((report) => ({
      fiscalYear: report['fiscalDateEnding']?.substring(0, 4) || 'Unknown',
      revenue: this.parseNumber(report['totalRevenue']),
      costOfRevenue: this.parseNumber(report['costOfRevenue']),
      grossProfit: this.parseNumber(report['grossProfit']),
      researchAndDevelopment: this.parseNumberOrNull(report['researchAndDevelopment']),
      sellingGeneralAdmin: this.parseNumberOrNull(report['sellingGeneralAndAdministrative']),
      operatingIncome: this.parseNumber(report['operatingIncome']),
      interestExpense: this.parseNumberOrNull(report['interestExpense']),
      netIncome: this.parseNumber(report['netIncome']),
      eps: this.parseNumber(report['reportedEPS']),
      epsDiluted: this.parseNumber(report['reportedEPS']),
      ebitda: this.parseNumber(report['ebitda']),
      sharesOutstanding: this.parseNumber(report['commonStockSharesOutstanding']),
      reportDate: report['fiscalDateEnding'] || '',
    }));
  }

  /**
   * Parse balance sheets
   */
  private parseBalanceSheets(
    reports: Record<string, string>[],
    years: number
  ): BalanceSheet[] {
    return reports.slice(0, years).map((report) => {
      const totalEquity = this.parseNumber(report['totalShareholderEquity']);
      const sharesOutstanding = this.parseNumber(report['commonStockSharesOutstanding']) || 1;

      return {
        fiscalYear: report['fiscalDateEnding']?.substring(0, 4) || 'Unknown',
        totalAssets: this.parseNumber(report['totalAssets']),
        currentAssets: this.parseNumber(report['totalCurrentAssets']),
        cash: this.parseNumber(report['cashAndCashEquivalentsAtCarryingValue']),
        shortTermInvestments: this.parseNumberOrNull(report['shortTermInvestments']),
        accountsReceivable: this.parseNumberOrNull(report['currentNetReceivables']),
        inventory: this.parseNumberOrNull(report['inventory']),
        totalLiabilities: this.parseNumber(report['totalLiabilities']),
        currentLiabilities: this.parseNumber(report['totalCurrentLiabilities']),
        longTermDebt: this.parseNumber(report['longTermDebt']),
        totalDebt: this.parseNumber(report['shortLongTermDebtTotal']),
        totalEquity,
        retainedEarnings: this.parseNumberOrNull(report['retainedEarnings']),
        bookValuePerShare: totalEquity / sharesOutstanding,
        reportDate: report['fiscalDateEnding'] || '',
      };
    });
  }

  /**
   * Parse cash flow statements
   */
  private parseCashFlowStatements(
    reports: Record<string, string>[],
    years: number
  ): CashFlowStatement[] {
    return reports.slice(0, years).map((report) => {
      const operatingCashFlow = this.parseNumber(report['operatingCashflow']);
      const capitalExpenditure = Math.abs(this.parseNumber(report['capitalExpenditures']));

      return {
        fiscalYear: report['fiscalDateEnding']?.substring(0, 4) || 'Unknown',
        netIncome: this.parseNumber(report['netIncome']),
        depreciation: this.parseNumber(report['depreciationDepletionAndAmortization']),
        operatingCashFlow,
        capitalExpenditure,
        investingCashFlow: this.parseNumber(report['cashflowFromInvestment']),
        financingCashFlow: this.parseNumber(report['cashflowFromFinancing']),
        freeCashFlow: operatingCashFlow - capitalExpenditure,
        dividendsPaid: this.parseNumberOrNull(report['dividendPayout']),
        stockRepurchases: this.parseNumberOrNull(report['paymentsForRepurchaseOfCommonStock']),
        reportDate: report['fiscalDateEnding'] || '',
      };
    });
  }

  /**
   * Fetch company profile
   */
  protected async fetchCompanyProfile(ticker: string): Promise<CompanyProfile> {
    const overview = await this.makeRequest<Record<string, string>>({
      function: 'OVERVIEW',
      symbol: ticker,
    });

    if (!overview || !overview['Symbol']) {
      throw new TickerNotFoundError(this.name, ticker);
    }

    return {
      ticker: overview['Symbol'],
      name: overview['Name'] || ticker,
      description: overview['Description'] || '',
      sector: overview['Sector'] || 'Unknown',
      industry: overview['Industry'] || 'Unknown',
      employees: this.parseNumberOrNull(overview['FullTimeEmployees']) as number | null,
      website: '', // Not provided by Alpha Vantage
      country: overview['Country'] || 'Unknown',
    };
  }

  /**
   * Search for stocks
   */
  async searchStocks(query: string): Promise<Array<{ ticker: string; name: string; exchange: string }>> {
    const data = await this.makeRequest<{
      bestMatches: Array<{
        '1. symbol': string;
        '2. name': string;
        '4. region': string;
      }>;
    }>({
      function: 'SYMBOL_SEARCH',
      keywords: query,
    });

    return (data.bestMatches || []).map((match) => ({
      ticker: match['1. symbol'],
      name: match['2. name'],
      exchange: match['4. region'],
    }));
  }

  /**
   * Parse number from string
   */
  private parseNumber(value: string | undefined): number {
    if (!value || value === 'None') return 0;
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
  }

  /**
   * Parse number or return null
   */
  private parseNumberOrNull(value: string | undefined): number | null {
    if (!value || value === 'None') return null;
    const num = parseFloat(value);
    return isNaN(num) ? null : num;
  }
}
