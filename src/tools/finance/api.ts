import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const BASE_URL = 'https://api.financialdatasets.ai';

export interface ApiResponse {
  data: Record<string, unknown>;
  url: string;
}

/**
 * Remove redundant fields from API payloads before they are returned to the LLM.
 * This reduces token usage while preserving the financial metrics needed for analysis.
 */
export function stripFieldsDeep(value: unknown, fields: readonly string[]): unknown {
  const fieldsToStrip = new Set(fields);

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(walk);
    }

    if (!node || typeof node !== 'object') {
      return node;
    }

    const record = node as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(record)) {
      if (fieldsToStrip.has(key)) {
        continue;
      }
      cleaned[key] = walk(child);
    }

    return cleaned;
  }

  return walk(value);
}


const A_SHARE_RE = /^\d{6}$/;
function isAShare(ticker: unknown): boolean {
  if (typeof ticker !== 'string') return false;
  const clean = ticker.trim().replace(/\.(SH|SZ)$/i, '');
  return A_SHARE_RE.test(clean);
}

async function routeAShare(
  endpoint: string,
  params: Record<string, string | number | string[] | undefined>,
): Promise<ApiResponse> {
  const {
    getSpot, getHistPrices, getIncomeStatements,
    getBalanceSheets, getCashFlowStatements, getAllFinancials,
    getMetricsSnapshot, getHistoricalMetrics, getEarnings,
    getNews, getFilings, getHolders,
  } = await import('./akshare-bridge.js');
  const ticker = (params.ticker as string) || '';
  const limit = (params.limit as number) || 4;
  const period = (params.period as string) || 'annual';
  const startDate = (params.start_date as string) || '';
  const endDate = (params.end_date as string) || '';
  const interval = (params.interval as string) || 'day';
  let result: Record<string, unknown>;
  if (endpoint.includes('/financials/income-statements')) {
    result = await getIncomeStatements(ticker, period, limit);
  } else if (endpoint.includes('/financials/balance-sheets')) {
    result = await getBalanceSheets(ticker, period, limit);
  } else if (endpoint.includes('/financials/cash-flow-statements')) {
    result = await getCashFlowStatements(ticker, period, limit);
  } else if (endpoint === '/financials/') {
    result = await getAllFinancials(ticker, period, limit);
  } else if (endpoint.includes('/financial-metrics/snapshot')) {
    result = await getMetricsSnapshot(ticker);
  } else if (endpoint.includes('/financial-metrics')) {
    result = await getHistoricalMetrics(ticker, period, limit);
  } else if (endpoint.includes('/prices/snapshot')) {
    result = await getSpot(ticker);
  } else if (endpoint.includes('/prices')) {
    result = await getHistPrices(ticker, startDate, endDate, interval);
  } else if (endpoint.includes('/earnings')) {
    result = await getEarnings(ticker || undefined, limit);
  } else if (endpoint.includes('/news')) {
    result = await getNews(ticker || undefined, limit);
  } else if (endpoint.includes('/filings')) {
    result = await getFilings(ticker, limit);
  } else if (endpoint.includes('/institutional-holdings')) {
    result = await getHolders(ticker, limit);
  } else if (endpoint.includes('/insider-trades')) {
    result = { data: { insider_trades: [] }, url: `akshare://block-trades/$\{ticker}` };
  } else {
    result = { data: {}, url: `akshare://$\{endpoint}/$\{ticker}` };
  }
  return { data: result.data as Record<string, unknown>, url: result.url as string } as ApiResponse;
}

function getApiKey(): string {
  return process.env.FINANCIAL_DATASETS_API_KEY || '';
}

/**
 * Shared request execution: handles API key, error handling, logging, and response parsing.
 */
async function executeRequest(
  url: string,
  label: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const apiKey = getApiKey();

  if (!apiKey) {
    logger.warn(`[Financial Datasets API] call without key: ${label}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'x-api-key': apiKey,
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Financial Datasets API] network error: ${label} — ${message}`);
    throw new Error(`[Financial Datasets API] request failed for ${label}: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[Financial Datasets API] error: ${label} — ${detail}`);
    throw new Error(`[Financial Datasets API] request failed: ${detail}`);
  }

  const data = await response.json().catch(() => {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[Financial Datasets API] parse error: ${label} — ${detail}`);
    throw new Error(`[Financial Datasets API] request failed: ${detail}`);
  });

  return data as Record<string, unknown>;
}

export const api = {
  async get(
    endpoint: string,
    params: Record<string, string | number | string[] | undefined>,
    options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<ApiResponse> {
    const label = describeRequest(endpoint, params);


    // Auto-route A-share tickers to AKShare bridge
    const ticker = params.ticker as string | undefined;
    const filerName = params.filer_name as string | undefined;
    if (isAShare(ticker) || isAShare(filerName)) {
      return routeAShare(endpoint, params);
    }
    // Check local cache first — avoids redundant network calls for immutable data
    if (options?.cacheable) {
      const cached = readCache(endpoint, params, options.ttlMs);
      if (cached) {
        return cached;
      }
    }

    const url = new URL(`${BASE_URL}${endpoint}`);

    // Add params to URL, handling arrays
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const data = await executeRequest(url.toString(), label, {});

    // Persist for future requests when the caller marked the response as cacheable
    if (options?.cacheable) {
      writeCache(endpoint, params, data, url.toString());
    }

    return { data, url: url.toString() };
  },

  async post(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<ApiResponse> {
    const label = `POST ${endpoint}`;
    const url = `${BASE_URL}${endpoint}`;

    const data = await executeRequest(url, label, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return { data, url };
  },
};

/** @deprecated Use `api.get` instead */
export const callApi = api.get;
