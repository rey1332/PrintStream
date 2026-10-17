// The statistical core of Terminal insights (P3): descriptive statistics,
// trend, a Holt linear forecast with intervals, and robust anomaly detection.
// Deterministic and explainable; the AI narrative (when allowed) only puts
// these results into words. Pure functions, no dependencies.

export interface Point {
  /** The period (ISO date of its start). */
  p: string;
  v: number;
}

export interface Describe {
  n: number;
  mean: number;
  sd: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  sum: number;
}

const round = (x: number, digits = 6) => {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function describe(values: number[]): Describe {
  const xs = values.filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, sd: 0, min: 0, q1: 0, median: 0, q3: 0, max: 0, sum: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    mean: round(mean),
    sd: round(sd),
    min: sorted[0],
    q1: round(quantile(sorted, 0.25)),
    median: round(quantile(sorted, 0.5)),
    q3: round(quantile(sorted, 0.75)),
    max: sorted[n - 1],
    sum: round(sum),
  };
}

export interface Trend {
  slope: number;
  intercept: number;
  r2: number;
  /** Change over the whole series, relative to its start (null when it starts at 0). */
  change: number | null;
}

/** Least-squares line through the values (x = 0, 1, 2…). */
export function linearTrend(ys: number[]): Trend {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0, change: null };
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (i - mx) * (ys[i] - my);
    sxx += (i - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  const start = intercept;
  const end = intercept + slope * (n - 1);
  return {
    slope: round(slope),
    intercept: round(intercept),
    r2: round(r2, 4),
    change: start ? round((end - start) / Math.abs(start), 4) : null,
  };
}

export interface ForecastPoint {
  step: number;
  value: number;
  low: number;
  high: number;
}

export interface Forecast {
  alpha: number;
  beta: number;
  /** One-step-ahead errors over the history. */
  rmse: number;
  mape: number | null;
  points: ForecastPoint[];
}

function holtRun(ys: number[], alpha: number, beta: number) {
  let level = ys[0];
  let trend = ys.length > 1 ? ys[1] - ys[0] : 0;
  let sse = 0;
  let ape = 0;
  let apeN = 0;
  for (let i = 1; i < ys.length; i += 1) {
    const predicted = level + trend;
    const err = ys[i] - predicted;
    sse += err * err;
    if (ys[i] !== 0) {
      ape += Math.abs(err / ys[i]);
      apeN += 1;
    }
    const prevLevel = level;
    level = alpha * ys[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  return { level, trend, sse, mape: apeN ? ape / apeN : null };
}

/**
 * Holt's linear exponential smoothing: the smoothing constants are chosen on
 * a grid by the smallest one-step-ahead error; the 95% interval widens with
 * the horizon (normal errors, sigma grows with the square root of the step).
 */
export function holtForecast(ys: number[], horizon: number): Forecast {
  if (ys.length < 3) {
    const v = ys.at(-1) ?? 0;
    return {
      alpha: 1,
      beta: 0,
      rmse: 0,
      mape: null,
      points: Array.from({ length: horizon }, (_, k) => ({
        step: k + 1,
        value: v,
        low: v,
        high: v,
      })),
    };
  }
  let best = { alpha: 0.5, beta: 0.1, ...holtRun(ys, 0.5, 0.1) };
  for (let a = 1; a <= 9; a += 1)
    for (let b = 1; b <= 9; b += 1) {
      const run = holtRun(ys, a / 10, b / 10);
      if (run.sse < best.sse) best = { alpha: a / 10, beta: b / 10, ...run };
    }
  const rmse = Math.sqrt(best.sse / (ys.length - 1));
  return {
    alpha: best.alpha,
    beta: best.beta,
    rmse: round(rmse),
    mape: best.mape === null ? null : round(best.mape, 4),
    points: Array.from({ length: horizon }, (_, k) => {
      const h = k + 1;
      const value = best.level + h * best.trend;
      const spread = 1.96 * rmse * Math.sqrt(h);
      return {
        step: h,
        value: round(value),
        low: round(value - spread),
        high: round(value + spread),
      };
    }),
  };
}

export interface Anomaly {
  index: number;
  p: string;
  v: number;
  expected: number;
  score: number;
}

function median(xs: number[]): number {
  return quantile(
    [...xs].sort((a, b) => a - b),
    0.5
  );
}

/**
 * Points far from their neighbourhood: each value against the median of a
 * centred window, scored with the modified z-score (median absolute
 * deviation); |score| above the threshold is an anomaly.
 */
export function robustAnomalies(points: Point[], window = 7, threshold = 3.5): Anomaly[] {
  const n = points.length;
  if (n < 5) return [];
  const half = Math.floor(window / 2);
  const expected = points.map((_, i) =>
    median(points.slice(Math.max(0, i - half), Math.min(n, i + half + 1)).map((x) => x.v))
  );
  const resid = points.map((x, i) => x.v - expected[i]);
  const center = median(resid);
  const mad = median(resid.map((r) => Math.abs(r - center)));
  if (!mad) return [];
  const out: Anomaly[] = [];
  resid.forEach((r, i) => {
    const score = (0.6745 * (r - center)) / mad;
    if (Math.abs(score) > threshold)
      out.push({
        index: i,
        p: points[i].p,
        v: points[i].v,
        expected: round(expected[i]),
        score: round(score, 2),
      });
  });
  return out;
}

/** How much to trust a forecast: in-sample accuracy, discounted for short histories. */
export function forecastConfidence(f: Forecast, n: number): number {
  const accuracy = f.mape === null ? 0.5 : Math.max(0, 1 - f.mape);
  return round(Math.min(1, accuracy * Math.min(1, n / 24)), 3);
}

export const anomalyConfidence = (n: number) => round(Math.min(1, n / 30), 3);

export const STATS_METHOD = {
  forecast: 'holt-linear grid(0.1..0.9) + 95% interval, v1',
  anomalies: 'rolling median (7) + modified z-score (MAD) > 3.5, v1',
  profile: 'column profile (counts, distinct, min/max/mean), v1',
} as const;
