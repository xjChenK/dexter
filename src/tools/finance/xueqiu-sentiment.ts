/**
 * Xueqiu (雪球) Social Sentiment Search Tool
 *
 * Uses Playwright to bypass Aliyun WAF, loads Xueqiu stock pages with
 * authenticated cookies, and intercepts community post data sorted by
 * popularity (reply/retweet count).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { chromium, Browser } from 'playwright';
import { formatToolResult } from '../types.js';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

function parseCookieString(raw: string): Array<{ name: string; value: string; domain: string; path: string }> {
  return raw.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    return {
      name: name.trim(),
      value: rest.join('=').trim(),
      domain: '.xueqiu.com',
      path: '/',
    };
  });
}

/** Convert A-share ticker to Xueqiu symbol format: 601138 -> SH601138 */
function toXueqiuSymbol(ticker: string): string {
  const clean = ticker.trim().toUpperCase().replace(/\.(SH|SZ)$/i, '');
  if (/^\d{6}$/.test(clean)) {
    if (clean.startsWith('60') || clean.startsWith('68')) {
      return `SH${clean}`;
    }
    return `SZ${clean}`;
  }
  return clean; // return as-is for non A-share
}

interface XueqiuPost {
  id: string;
  title: string;
  text: string;
  author: string;
  authorFollowers: number;
  replyCount: number;
  retweetCount: number;
  likeCount: number;
  createdAt: string;
  url: string;
}

const XueqiuSearchSchema = z.object({
  ticker: z.string().describe("A-share stock ticker, e.g. '601138' or 'SH601138'"),
  sort: z.enum(['hot', 'time']).default('hot').describe("Sort by heat/popularity ('hot') or recency ('time')"),
  limit: z.number().default(10).describe('Maximum number of posts to return (default: 10, max: 30)'),
});

export const XUEQIU_SENTIMENT_DESCRIPTION = `
Searches Xueqiu (雪球) community for stock-related social sentiment. Fetches individual
stock posts sorted by popularity or recency, including reply counts, retweets, and opinions.

## When to Use
- Gauge retail investor sentiment on a specific A-share stock
- Find popular opinions, bull/bear arguments from the Xueqiu community
- Track what retail investors are discussing about a stock
- Identify sentiment shifts around earnings, news events, or price moves

## When NOT to Use
- Financial data, ratios, statements (use get_financials)
- Stock prices (use get_market_data)
- News headlines (the news tool is faster for that)

## Sort Modes
- 'hot': posts sorted by reply + retweet count (most discussed first)
- 'time': most recent posts first
`.trim();

function normalizeTickerLocal(ticker: string): string {
  const clean = ticker.trim().toUpperCase().replace(/\.(SH|SZ)$/i, '');
  if (clean.startsWith('SH') || clean.startsWith('SZ')) return clean;
  if (/^\d{6}$/.test(clean)) {
    return clean.startsWith('60') || clean.startsWith('68') ? `SH${clean}` : `SZ${clean}`;
  }
  return clean;
}

export const xueqiuSentimentTool = new DynamicStructuredTool({
  name: 'xueqiu_sentiment',
  description: XUEQIU_SENTIMENT_DESCRIPTION,
  schema: XueqiuSearchSchema,
  func: async (input) => {
    const cookieRaw = process.env.XUEQIU_COOKIE || '';
    if (!cookieRaw) {
      return formatToolResult({ error: 'XUEQIU_COOKIE not set in .env' }, []);
    }

    const symbol = toXueqiuSymbol(input.ticker);
    const limit = Math.min(input.limit, 30);
    const stockUrl = `https://xueqiu.com/S/${symbol}`;

    const bx = await getBrowser();
    const context = await bx.newContext();
    const page = await context.newPage();

    // Collect intercepted post data
    const postsData: Array<Record<string, unknown>> = [];

    try {
      // Set cookies before navigating
      const cookies = parseCookieString(cookieRaw);
      await context.addCookies(cookies);

      // Intercept the stock timeline API responses
      page.on('response', async (response) => {
        const url = response.url();
        // Xueqiu stock timeline API pattern
        if (url.includes('/statuses/stock_timeline') || url.includes('/search/status')) {
          try {
            const json = await response.json();
            if (json && json.list) {
              for (const item of json.list) {
                const data = item.data || item;
                const user = data.user || {};
                postsData.push({
                  id: String(data.id || ''),
                  title: String(data.title || '').slice(0, 100),
                  text: String(data.text || data.description || '').slice(0, 500),
                  author: String(user.screen_name || user.name || ''),
                  author_followers: Number(user.followers_count || 0),
                  reply_count: Number(data.reply_count || data.reply || 0),
                  retweet_count: Number(data.retweet_count || data.retweet || 0),
                  like_count: Number(data.like_count || data.fav_count || 0),
                  created_at: String(data.created_at || data.timeBefore || ''),
                  url: `https://xueqiu.com${data.target || ''}`,
                });
              }
            }
          } catch {
            // Non-JSON or parsing error, skip
          }
        }
      });

      // Navigate to the stock page
      await page.goto(stockUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for posts to load (the page makes API calls that we intercept)
      await page.waitForTimeout(5000);

      // Scroll a bit to trigger loading
      await page.evaluate(() => window.scrollBy(0, 300));
      await page.waitForTimeout(3000);

    } catch (error) {
      await context.close();
      return formatToolResult({
        error: 'Failed to fetch Xueqiu posts',
        details: error instanceof Error ? error.message : String(error),
      }, []);
    }

    await context.close();

    // Sort by popularity (hot) or time
    if (input.sort === 'hot') {
      postsData.sort((a, b) => {
        const aScore = (Number(a.reply_count) || 0) + (Number(a.retweet_count) || 0) * 2;
        const bScore = (Number(b.reply_count) || 0) + (Number(b.retweet_count) || 0) * 2;
        return bScore - aScore;
      });
    }

    const limited = postsData.slice(0, limit);

    if (limited.length === 0) {
      return formatToolResult(
        { message: `No posts found for ${symbol}. The stock might not have recent discussions.` },
        [stockUrl],
      );
    }

    return formatToolResult(
      {
        symbol,
        sort: input.sort,
        total_found: postsData.length,
        posts: limited,
      },
      [stockUrl],
    );
  },
});

/** Clean up browser on shutdown */
export async function closeXueqiuBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
