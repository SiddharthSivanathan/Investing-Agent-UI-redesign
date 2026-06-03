/**
 * Discounted Cash Flow (DCF) Model
 *
 * Calculates intrinsic value using the DCF method.
 * Core principle: A company's value equals the present value of its future cash flows.
 *
 * References:
 * - Warren Buffett's owner earnings concept
 * - Standard two-stage DCF model with terminal value
 */

import type { Financials, StockQuote } from '../providers/types.js';
import { calculateCAGR } from './ratios.js';

/**
 * DCF calculation parameters
 */
export interface DCFParams {
  /** Discount rate (WACC or required return) */
  discountRate: number;
  /** Terminal growth rate (should not exceed GDP growth) */
  terminalGrowthRate: number;
  /** Number of years to project */
  projectionYears: number;
  /** Custom growth rate (if not provided, estimated from history) */
  customGrowthRate?: number;
}

/**
 * DCF calculation result
 */
export interface DCFResult {
  /** Intrinsic value per share */
  intrinsicValue: number;
  /** Projected free cash flows */
  projectedFcf: number[];
  /** Terminal value */
  terminalValue: number;
  /** Present value of projected FCF */
  pvOfFcf: number;
  /** Present value of terminal value */
  pvOfTerminal: number;
  /** Total enterprise value */
  enterpriseValue: number;
  /** Assumptions used */
  assumptions: {
    discountRate: number;
    terminalGrowthRate: number;
    projectionYears: number;
    estimatedGrowthRate: number;
    startingFcf: number;
    /** Which cash measure was projected when FCF was unusable */
    cashSource?: 'fcf' | 'ocf' | 'owner-earnings' | 'net-income';
  };
}

/**
 * Calculate DCF intrinsic value
 *
 * Two-stage DCF model:
 * 1. Stage 1: Project FCF for n years with growth rate
 * 2. Stage 2: Calculate terminal value using perpetuity growth formula
 *
 * @param financials - Financial statement data
 * @param quote - Current quote data
 * @param params - DCF parameters
 * @returns DCF calculation result
 */
export function calculateDCF(
  financials: Financials,
  quote: StockQuote,
  params: DCFParams
): DCFResult {
  const { discountRate, terminalGrowthRate, projectionYears, customGrowthRate } = params;
  const { cashFlowStatements, incomeStatements } = financials;

  // Pick the best available cash measure (in order of preference):
  //   1. Free cash flow (OCF - CapEx)        — Buffett's gold standard
  //   2. Operating cash flow                  — when CapEx is missing/noisy
  //   3. Owner earnings (NI + D&A - 70% CapEx)
  //   4. Net income                           — last resort
  // The label is exposed in `assumptions.cashSource` so the UI can be honest
  // about what was projected.
  let currentFcf = cashFlowStatements[0]?.freeCashFlow || 0;
  let cashSource: 'fcf' | 'ocf' | 'owner-earnings' | 'net-income' = 'fcf';

  if (currentFcf <= 0) {
    const ocf = cashFlowStatements[0]?.operatingCashFlow || 0;
    if (ocf > 0) {
      currentFcf = ocf;
      cashSource = 'ocf';
    } else {
      const ni = incomeStatements[0]?.netIncome || 0;
      const dep = cashFlowStatements[0]?.depreciation || 0;
      const capex = cashFlowStatements[0]?.capitalExpenditure || 0;
      const ownerEarnings = ni + dep - capex * 0.7;
      if (ownerEarnings > 0) {
        currentFcf = ownerEarnings;
        cashSource = 'owner-earnings';
      } else if (ni > 0) {
        currentFcf = ni;
        cashSource = 'net-income';
      } else {
        return createNegativeFcfResult(params);
      }
    }
  }

  // Estimate growth rate from history if not provided
  let growthRate = customGrowthRate;

  if (growthRate === undefined) {
    growthRate = estimateGrowthRate(financials);
  }

  // Cap growth rate at reasonable levels
  // Warren Buffett advises using conservative estimates
  growthRate = Math.max(-0.10, Math.min(growthRate, 0.25));

  // Terminal growth should never exceed economy's long-term growth
  const safeTerminalGrowth = Math.min(terminalGrowthRate, discountRate - 0.01);

  // Project FCF for each year
  const projectedFcf: number[] = [];
  let fcf = currentFcf;

  for (let year = 1; year <= projectionYears; year++) {
    // Gradually reduce growth rate towards terminal rate
    const yearGrowthRate = growthRate - ((growthRate - safeTerminalGrowth) * (year / projectionYears));
    fcf = fcf * (1 + yearGrowthRate);
    projectedFcf.push(fcf);
  }

  // Calculate present value of projected FCF
  let pvOfFcf = 0;
  for (let year = 1; year <= projectionYears; year++) {
    const discountFactor = Math.pow(1 + discountRate, year);
    pvOfFcf += projectedFcf[year - 1] / discountFactor;
  }

  // Calculate terminal value using Gordon Growth Model
  // TV = FCF(n+1) / (r - g)
  // where FCF(n+1) = FCF(n) * (1 + g)
  const terminalFcf = projectedFcf[projectionYears - 1] * (1 + safeTerminalGrowth);
  const terminalValue = terminalFcf / (discountRate - safeTerminalGrowth);

  // Present value of terminal value
  const pvOfTerminal = terminalValue / Math.pow(1 + discountRate, projectionYears);

  // Total enterprise value
  const enterpriseValue = pvOfFcf + pvOfTerminal;

  // Get shares outstanding
  const sharesOutstanding = incomeStatements[0]?.sharesOutstanding || 1;

  // Equity value = Enterprise Value - Net Debt
  const netDebt = (financials.balanceSheets[0]?.totalDebt || 0) -
                  (financials.balanceSheets[0]?.cash || 0);
  const equityValue = enterpriseValue - netDebt;

  // Intrinsic value per share
  const intrinsicValue = Math.max(0, equityValue / sharesOutstanding);

  return {
    intrinsicValue,
    projectedFcf,
    terminalValue,
    pvOfFcf,
    pvOfTerminal,
    enterpriseValue,
    assumptions: {
      discountRate,
      terminalGrowthRate: safeTerminalGrowth,
      projectionYears,
      estimatedGrowthRate: growthRate,
      startingFcf: currentFcf,
      cashSource,
    },
  };
}

/**
 * Estimate growth rate from historical data
 *
 * Uses a blend of:
 * - Historical FCF growth
 * - Historical revenue growth
 * - Historical EPS growth
 *
 * Applies conservatism by taking the lower estimate
 */
function estimateGrowthRate(financials: Financials): number {
  const { cashFlowStatements, incomeStatements } = financials;

  const growthRates: number[] = [];

  // FCF growth
  if (cashFlowStatements.length >= 3) {
    const years = Math.min(cashFlowStatements.length - 1, 5);
    const startFcf = cashFlowStatements[years]?.freeCashFlow;
    const endFcf = cashFlowStatements[0]?.freeCashFlow;

    if (startFcf && startFcf > 0 && endFcf && endFcf > 0) {
      const fcfGrowth = calculateCAGR(startFcf, endFcf, years);
      if (fcfGrowth !== null) growthRates.push(fcfGrowth);
    }
  }

  // Revenue growth
  if (incomeStatements.length >= 3) {
    const years = Math.min(incomeStatements.length - 1, 5);
    const startRevenue = incomeStatements[years]?.revenue;
    const endRevenue = incomeStatements[0]?.revenue;

    if (startRevenue && startRevenue > 0 && endRevenue && endRevenue > 0) {
      const revenueGrowth = calculateCAGR(startRevenue, endRevenue, years);
      if (revenueGrowth !== null) growthRates.push(revenueGrowth);
    }
  }

  // EPS growth
  if (incomeStatements.length >= 3) {
    const years = Math.min(incomeStatements.length - 1, 5);
    const startEps = incomeStatements[years]?.eps;
    const endEps = incomeStatements[0]?.eps;

    if (startEps && startEps > 0 && endEps && endEps > 0) {
      const epsGrowth = calculateCAGR(startEps, endEps, years);
      if (epsGrowth !== null) growthRates.push(epsGrowth);
    }
  }

  // If no growth data, use conservative default
  if (growthRates.length === 0) {
    return 0.05; // 5% default
  }

  // Use the median growth rate (more robust than mean)
  growthRates.sort((a, b) => a - b);
  const median = growthRates[Math.floor(growthRates.length / 2)];

  // Apply conservatism - reduce by 20%
  return median * 0.8;
}

/**
 * Create result for negative FCF case
 */
function createNegativeFcfResult(params: DCFParams): DCFResult {
  return {
    intrinsicValue: 0,
    projectedFcf: [],
    terminalValue: 0,
    pvOfFcf: 0,
    pvOfTerminal: 0,
    enterpriseValue: 0,
    assumptions: {
      discountRate: params.discountRate,
      terminalGrowthRate: params.terminalGrowthRate,
      projectionYears: params.projectionYears,
      estimatedGrowthRate: 0,
      startingFcf: 0,
      cashSource: undefined,
    },
  };
}

/**
 * Perform sensitivity analysis on DCF
 *
 * Shows how intrinsic value changes with different discount rates and growth rates
 */
export function dcfSensitivity(
  financials: Financials,
  quote: StockQuote,
  baseParams: DCFParams
): { discountRates: number[]; growthRates: number[]; values: number[][] } {
  const discountRates = [
    baseParams.discountRate - 0.02,
    baseParams.discountRate - 0.01,
    baseParams.discountRate,
    baseParams.discountRate + 0.01,
    baseParams.discountRate + 0.02,
  ];

  const growthRates = [
    (baseParams.customGrowthRate || 0.05) - 0.02,
    (baseParams.customGrowthRate || 0.05) - 0.01,
    baseParams.customGrowthRate || 0.05,
    (baseParams.customGrowthRate || 0.05) + 0.01,
    (baseParams.customGrowthRate || 0.05) + 0.02,
  ];

  const values: number[][] = [];

  for (const dr of discountRates) {
    const row: number[] = [];
    for (const gr of growthRates) {
      const result = calculateDCF(financials, quote, {
        ...baseParams,
        discountRate: dr,
        customGrowthRate: gr,
      });
      row.push(result.intrinsicValue);
    }
    values.push(row);
  }

  return { discountRates, growthRates, values };
}
