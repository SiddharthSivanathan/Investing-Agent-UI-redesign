/**
 * Provider Registry and Factory
 *
 * Central point for managing data providers.
 * Users can register custom providers here.
 */

import type { DataProvider, ProviderConfig, ProviderFactory } from './types.js';
import { YahooFinanceProvider } from './yahoo-finance.js';
import { YahooDirectProvider } from './yahoo-direct.js';
import { AlphaVantageProvider } from './alpha-vantage.js';
import { FinnhubProvider } from './finnhub.js';
import { StockAnalysisProvider } from './stockanalysis.js';

// Re-export types and classes
export * from './types.js';
export * from './base.js';
export { YahooFinanceProvider } from './yahoo-finance.js';
export { YahooDirectProvider } from './yahoo-direct.js';
export { AlphaVantageProvider } from './alpha-vantage.js';
export { FinnhubProvider } from './finnhub.js';
export { StockAnalysisProvider } from './stockanalysis.js';

/**
 * Provider Registry
 *
 * Register new providers by adding them to this map.
 * The key is the provider name used in configuration.
 */
const providerFactories: Map<string, ProviderFactory> = new Map([
  ['yahoo-finance', (config) => new YahooFinanceProvider(config)],
  ['yahoo-direct', (config) => new YahooDirectProvider(config)],
  ['stockanalysis', (config) => new StockAnalysisProvider(config)],
  ['alpha-vantage', (config) => new AlphaVantageProvider(config)],
  ['finnhub', (config) => new FinnhubProvider(config)],
]);

/**
 * Current active provider instance
 */
let currentProvider: DataProvider | null = null;
let currentProviderName = 'yahoo-finance';

/**
 * Register a new provider
 *
 * @param name - Provider identifier
 * @param factory - Factory function to create provider instances
 *
 * @example
 * ```typescript
 * import { registerProvider } from './providers';
 * import { MyCustomProvider } from './my-custom-provider';
 *
 * registerProvider('my-provider', (config) => new MyCustomProvider(config));
 * ```
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  providerFactories.set(name.toLowerCase(), factory);
}

/**
 * Get list of available provider names
 */
export function getAvailableProviders(): string[] {
  return Array.from(providerFactories.keys());
}

/**
 * Get provider info for all registered providers
 */
export function getProviderInfo(): Array<{
  name: string;
  displayName: string;
  requiresApiKey: boolean;
  isActive: boolean;
}> {
  const providers: Array<{
    name: string;
    displayName: string;
    requiresApiKey: boolean;
    isActive: boolean;
  }> = [];

  for (const [name, factory] of providerFactories) {
    let instance: DataProvider | null = null;
    try {
      instance = factory();
    } catch {
      // Provider constructor refused (likely missing API key). Re-try with a
      // dummy key just to read the static-ish metadata. We never call the
      // instance, so the bad key is harmless.
      try {
        instance = factory({ name, apiKey: '__metadata-probe__' });
      } catch {
        instance = null;
      }
    }
    providers.push({
      name,
      displayName: instance?.displayName ?? name,
      requiresApiKey: instance?.requiresApiKey ?? true,
      isActive: name === currentProviderName,
    });
  }

  return providers;
}

/**
 * Create a provider instance
 *
 * @param name - Provider name (defaults to yahoo-finance)
 * @param config - Provider configuration
 */
export function createProvider(name = 'yahoo-finance', config?: ProviderConfig): DataProvider {
  const factory = providerFactories.get(name.toLowerCase());

  if (!factory) {
    const available = getAvailableProviders().join(', ');
    throw new Error(`Unknown provider: ${name}. Available providers: ${available}`);
  }

  return factory(config);
}

/**
 * Set the active provider
 *
 * @param name - Provider name
 * @param config - Provider configuration
 */
export async function setProvider(name: string, config?: ProviderConfig): Promise<void> {
  // Construct the provider — this surfaces missing-API-key errors immediately
  // without burning quota on a health check.
  const provider = createProvider(name, config);
  currentProvider = provider;
  currentProviderName = name;
}

/**
 * Get the current active provider
 * Creates default provider if none is set
 */
export function getProvider(): DataProvider {
  if (!currentProvider) {
    const providerName = process.env.PROVIDER || 'yahoo-direct';

    currentProvider = createProvider(providerName, {
      name: providerName,
      apiKey:
        process.env.FINNHUB_API_KEY ||
        process.env.ALPHA_VANTAGE_API_KEY,
    });

    currentProviderName = providerName;
  }

  return currentProvider;
}

/**
 * Get current provider name
 */
export function getCurrentProviderName(): string {
  return currentProviderName;
}

/**
 * Check if a provider exists
 */
export function hasProvider(name: string): boolean {
  return providerFactories.has(name.toLowerCase());
}
