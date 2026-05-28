import { config } from "../config.js";
import { log } from "../logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { safeNumber } from "../utils/number.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;
const DEFAULT_RSI_LENGTH = 2;
const DEFAULT_RSI_OVERSOLD = 10;
const DEFAULT_RSI_OVERBOUGHT = 90;

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "5_MINUTE" || value === "15_MINUTE");
}

function safeNum(value) {
  return safeNumber(value, null);
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    open: safeNum(candle.open ?? candle.o),
    high: safeNum(candle.high ?? candle.h),
    low: safeNum(candle.low ?? candle.l),
    close: safeNum(candle.close ?? candle.c),
    previousClose: safeNum(previousCandle.close ?? previousCandle.c),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? DEFAULT_RSI_OVERSOLD);
  const overbought = Number(config.indicators.rsiOverbought ?? DEFAULT_RSI_OVERBOUGHT);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const rsiIsOversold = rsi != null && rsi <= oversold;
  const rsiIsOverbought = rsi != null && rsi >= overbought;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const bullishSupertrend = summary.supertrendBreakUp || isBullish;
  const bearishSupertrend = summary.supertrendBreakDown || isBearish;
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
          confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
          reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
          signal: summary,
        }
        : {
          confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
          reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
          signal: summary,
        };
    case "rsi_reversal":
      return side === "entry"
        ? {
          confirmed: rsiIsOversold,
          reason: rsiIsOversold
            ? `RSI ${rsi} <= oversold ${oversold}; price has pulled back enough for a bounce setup`
            : `RSI ${rsi ?? "n/a"} is not <= oversold ${oversold}; waiting for a deeper pullback`,
          signal: summary,
        }
        : {
          confirmed: rsiIsOverbought,
          reason: rsiIsOverbought
            ? `RSI ${rsi} >= overbought ${overbought}; short-term momentum is stretched upward`
            : `RSI ${rsi ?? "n/a"} is not >= overbought ${overbought}; waiting for stronger exit signal`,
          signal: summary,
        };
    case "bollinger_reversion":
      return side === "entry"
        ? {
          confirmed: close != null && lowerBand != null && close <= lowerBand,
          reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
          signal: summary,
        }
        : {
          confirmed: close != null && upperBand != null && close >= upperBand,
          reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
          signal: summary,
        };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
          confirmed: rsiIsOversold && bullishSupertrend,
          reason: rsiIsOversold && bullishSupertrend
            ? `RSI ${rsi} <= oversold ${oversold} with bullish Supertrend; strong confluence`
            : `Needs RSI <= oversold ${oversold} and bullish Supertrend; RSI ${rsi ?? "n/a"}, Supertrend ${summary.supertrendDirection}`,
          signal: summary,
        }
        : {
          confirmed: rsiIsOverbought && bearishSupertrend,
          reason: rsiIsOverbought && bearishSupertrend
            ? `RSI ${rsi} >= overbought ${overbought} with bearish Supertrend; strong exit confluence`
            : `Needs RSI >= overbought ${overbought} and bearish Supertrend; RSI ${rsi ?? "n/a"}, Supertrend ${summary.supertrendDirection}`,
          signal: summary,
        };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
          confirmed:
            summary.supertrendBreakUp ||
            (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
            (rsi != null && rsi <= oversold),
          reason: "Supertrend bullish confirmation or RSI oversold",
          signal: summary,
        }
        : {
          confirmed:
            summary.supertrendBreakDown ||
            (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
            (rsi != null && rsi >= overbought),
          reason: "Supertrend bearish confirmation or RSI overbought",
          signal: summary,
        };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
          confirmed:
            close != null &&
            lowerBand != null &&
            close <= lowerBand &&
            rsi != null &&
            rsi <= oversold,
          reason: "Close at/below lower band with RSI oversold",
          signal: summary,
        }
        : {
          confirmed:
            close != null &&
            upperBand != null &&
            close >= upperBand &&
            rsi != null &&
            rsi >= overbought,
          reason: "Close at/above upper band with RSI overbought",
          signal: summary,
        };
    case "fibo_reclaim":
      return side === "entry"
        ? {
          confirmed:
            crossedUp(summary.fib618) ||
            crossedUp(summary.fib50) ||
            crossedUp(summary.fib786),
          reason: "Price reclaimed a key Fibonacci level",
          signal: summary,
        }
        : {
          confirmed:
            crossedUp(summary.fib618) ||
            crossedUp(summary.fib50),
          reason: "Price reclaimed a key Fibonacci level upward",
          signal: summary,
        };
    case "fibo_reject":
      return side === "entry"
        ? {
          confirmed:
            crossedDown(summary.fib618) ||
            crossedDown(summary.fib50),
          reason: "Price rejected from a key Fibonacci level",
          signal: summary,
        }
        : {
          confirmed:
            crossedDown(summary.fib618) ||
            crossedDown(summary.fib50) ||
            crossedDown(summary.fib786),
          reason: "Price rejected below a key Fibonacci level",
          signal: summary,
        };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

function evaluateRedDownCandle(payload) {
  const summary = buildSignalSummary(payload);
  const open = summary.open;
  const close = summary.close;
  const previousClose = summary.previousClose;
  const isRed = open != null && close != null && close < open;
  const isDown = close != null && previousClose != null ? close <= previousClose : isRed;
  const direction = isRed ? "red" : open != null && close != null && close > open ? "green" : "flat";

  return {
    confirmed: isRed && isDown,
    reason: open == null || close == null
      ? "Latest candle open/close unavailable"
      : `Latest candle is ${direction}: open ${open}, close ${close}${previousClose != null ? `, previous close ${previousClose}` : ""}`,
    signal: {
      open,
      high: summary.high,
      low: summary.low,
      close,
      previousClose,
      direction,
      red: isRed,
      down: isDown,
    },
  };
}

export async function fetchChartIndicatorsForMint(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? DEFAULT_RSI_LENGTH,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  return agentMeridianJson(`/chart-indicators/${mint}?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
  });
}

export async function confirmSingleSideSolEntryCandle({
  mint,
  intervals = config.indicators.singleSideSolEntryCandleIntervals || config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.singleSideSolEntryCandleGuard) {
    return { enabled: false, confirmed: true, reason: "Single-side SOL candle guard disabled", intervals: [] };
  }

  if (!mint) {
    return { enabled: true, confirmed: false, reason: "Missing mint for single-side SOL candle guard", intervals: [] };
  }
  // Sanity-check mint format (base58 ~32-44 chars). Reject obvious non-mints like "Ebola".
  if (typeof mint !== "string" || mint.length < 32 || mint.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(mint)) {
    return { enabled: true, confirmed: false, reason: `Invalid mint format for candle guard: "${String(mint).slice(0, 16)}"`, intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: true, confirmed: false, reason: "No candle intervals configured for single-side SOL entry guard", intervals: [] };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluateRedDownCandle(payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Single-side SOL candle guard failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: false,
      skipped: true,
      reason: "Candle guard unavailable; refusing single-side SOL entry",
      intervals: results,
    };
  }

  const requireAll = config.indicators.singleSideSolEntryRequireAllIntervals ?? true;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `Red/down candle confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `Waiting for red/down candle; latest was not red/down on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}
