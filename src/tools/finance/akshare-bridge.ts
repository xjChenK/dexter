/**
 * AKShare stdio bridge client — TypeScript interface to the Python bridge process.
 *
 * Uses a long-lived Python subprocess that reads JSON commands from stdin
 * and writes JSON responses to stdout. Much more reliable than HTTP server
 * because process lifecycle is explicit.
 */

import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = join(__dirname, "akshare_bridge.py");

// === A-share ticker detection ===
const A_SHARE_RE = /^\d{6}$/;
export function isAShareTicker(ticker: string): boolean {
  return A_SHARE_RE.test(ticker.trim().replace(/\.(SH|SZ)$/i, ""));
}

// === Bridge process management ===
let bridgeProcess: ChildProcess | null = null;
let pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let requestId = 0;
let bridgeDead = false;

function getBridge(): ChildProcess {
  if (bridgeDead || bridgeProcess?.killed) {
    bridgeProcess = null;
    bridgeDead = false;
    pendingRequests.forEach(({ reject }) =>
      reject(new Error("Bridge process died"))
    );
    pendingRequests.clear();
  }

  if (!bridgeProcess) {
    bridgeProcess = spawn("python3", [BRIDGE_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    const rl = createInterface({ input: bridgeProcess.stdout! });
    rl.on("line", (line: string) => {
      try {
        const response = JSON.parse(line);
        // Find the oldest pending request to resolve
        const [firstId] = pendingRequests.keys();
        if (firstId !== undefined) {
          const { resolve } = pendingRequests.get(firstId)!;
          pendingRequests.delete(firstId);
          resolve(response);
        }
      } catch {
        // Ignore non-JSON lines (stderr/startup noise)
      }
    });

    bridgeProcess.stderr?.on("data", (data: Buffer) => {
      // Suppress stderr—AKShare prints tqdm progress bars there
    });

    bridgeProcess.on("exit", (code) => {
      bridgeDead = true;
      if (code !== 0 && code !== null) {
        pendingRequests.forEach(({ reject }) =>
          reject(new Error(`Bridge exited with code ${code}`))
        );
        pendingRequests.clear();
      }
    });

    bridgeProcess.on("error", (err) => {
      bridgeDead = true;
      pendingRequests.forEach(({ reject }) => reject(err));
      pendingRequests.clear();
    });
  }

  return bridgeProcess;
}

async function sendCommand(
  cmd: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const bridge = getBridge();
  const id = ++requestId;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject });

    const payload = JSON.stringify(cmd) + "\n";
    bridge.stdin!.write(payload);

    // Timeout after 120s for slow AKShare calls
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Bridge command timed out: ${cmd.method}`));
      }
    }, 120_000);
  });
}

// === API-compatible interface ===
// Each function returns { data: {...}, url: "..." } matching financialdatasets.ai format

export async function getSpot(ticker: string) {
  return sendCommand({ method: "spot", ticker });
}

export async function getHistPrices(
  ticker: string,
  startDate: string,
  endDate: string,
  interval: string = "day"
) {
  return sendCommand({ method: "hist", ticker, start_date: startDate, end_date: endDate, interval });
}

export async function getTickers() {
  return sendCommand({ method: "tickers" });
}

export async function getIncomeStatements(
  ticker: string,
  period: string = "annual",
  limit: number = 4
) {
  return sendCommand({ method: "income", ticker, period, limit });
}

export async function getBalanceSheets(
  ticker: string,
  period: string = "annual",
  limit: number = 4
) {
  return sendCommand({ method: "balance", ticker, period, limit });
}

export async function getCashFlowStatements(
  ticker: string,
  period: string = "annual",
  limit: number = 4
) {
  return sendCommand({ method: "cashflow", ticker, period, limit });
}

export async function getAllFinancials(
  ticker: string,
  period: string = "annual",
  limit: number = 4
) {
  return sendCommand({ method: "all_fin", ticker, period, limit });
}

export async function getMetricsSnapshot(ticker: string) {
  return sendCommand({ method: "metrics_snap", ticker });
}

export async function getHistoricalMetrics(
  ticker: string,
  period: string = "annual",
  limit: number = 4
) {
  return sendCommand({ method: "metrics_hist", ticker, period, limit });
}

export async function getEarnings(ticker?: string, limit: number = 10) {
  return sendCommand({ method: "earnings", ticker: ticker || null, limit });
}

export async function getNews(ticker?: string, limit: number = 5) {
  return sendCommand({ method: "news", ticker: ticker || null, limit });
}

export async function getFilings(ticker: string, limit: number = 10) {
  return sendCommand({ method: "filings", ticker, limit });
}

export async function getHolders(ticker: string, limit: number = 10) {
  return sendCommand({ method: "holders", ticker, limit });
}

/**
 * Cleanly shut down the bridge subprocess.
 */
export function shutdownBridge() {
  if (bridgeProcess && !bridgeProcess.killed) {
    bridgeProcess.kill();
  }
  bridgeProcess = null;
  bridgeDead = false;
}
