import { computeMean, computeStdDev } from './stats-helpers';

export interface FitResult {
  name: 'normal' | 'exponential' | 'lognormal';
  params: Record<string, number>;
  logLikelihood: number;
  aic: number;
}

function normalLogLik(values: number[], mu: number, sigma: number): number {
  if (sigma <= 0) return -Infinity;
  const n = values.length;
  let ll = -n * Math.log(sigma) - 0.5 * n * Math.log(2 * Math.PI);
  for (const x of values) ll -= 0.5 * ((x - mu) / sigma) ** 2;
  return ll;
}

function expLogLik(values: number[], rate: number): number {
  if (rate <= 0) return -Infinity;
  const n = values.length;
  let ll = n * Math.log(rate);
  for (const x of values) ll -= rate * x;
  return ll;
}

function lognormalLogLik(values: number[], mu: number, sigma: number): number {
  if (sigma <= 0 || values.some((v) => v <= 0)) return -Infinity;
  const n = values.length;
  let ll = -n * Math.log(sigma) - 0.5 * n * Math.log(2 * Math.PI);
  for (const x of values) {
    ll -= Math.log(x) + 0.5 * ((Math.log(x) - mu) / sigma) ** 2;
  }
  return ll;
}

export function fitDistribution(values: number[]): FitResult | null {
  if (!values.length || values.length < 3) return null;

  const mu = computeMean(values);
  const sigma = computeStdDev(values);
  const fits: FitResult[] = [];

  const llN = normalLogLik(values, mu, sigma);
  if (isFinite(llN)) {
    fits.push({ name: 'normal', params: { mu, sigma }, logLikelihood: llN, aic: 2 * 2 - 2 * llN });
  }

  const allPositive = values.every((v) => v > 0);
  if (allPositive && mu > 0) {
    const rate = 1 / mu;
    const llE = expLogLik(values, rate);
    if (isFinite(llE)) {
      fits.push({
        name: 'exponential',
        params: { rate },
        logLikelihood: llE,
        aic: 2 * 1 - 2 * llE,
      });
    }

    const logs = values.map(Math.log);
    const logMu = computeMean(logs);
    const logSigma = computeStdDev(logs);
    const llL = lognormalLogLik(values, logMu, logSigma);
    if (isFinite(llL)) {
      fits.push({
        name: 'lognormal',
        params: { mu: logMu, sigma: logSigma },
        logLikelihood: llL,
        aic: 2 * 2 - 2 * llL,
      });
    }
  }

  if (!fits.length) return null;
  fits.sort((a, b) => a.aic - b.aic);
  return fits[0];
}

export function fitSpecific(name: FitResult['name'], values: number[]): FitResult | null {
  if (!values.length || values.length < 3) return null;
  const mu = computeMean(values);
  const sigma = computeStdDev(values);

  if (name === 'normal') {
    const ll = normalLogLik(values, mu, sigma);
    if (!isFinite(ll)) return null;
    return { name, params: { mu, sigma }, logLikelihood: ll, aic: 2 * 2 - 2 * ll };
  }
  if (name === 'exponential') {
    if (!values.every((v) => v > 0) || mu <= 0) return null;
    const rate = 1 / mu;
    const ll = expLogLik(values, rate);
    if (!isFinite(ll)) return null;
    return { name, params: { rate }, logLikelihood: ll, aic: 2 * 1 - 2 * ll };
  }
  if (name === 'lognormal') {
    if (!values.every((v) => v > 0)) return null;
    const logs = values.map(Math.log);
    const logMu = computeMean(logs);
    const logSigma = computeStdDev(logs);
    const ll = lognormalLogLik(values, logMu, logSigma);
    if (!isFinite(ll)) return null;
    return { name, params: { mu: logMu, sigma: logSigma }, logLikelihood: ll, aic: 2 * 2 - 2 * ll };
  }
  return null;
}
