// Runs once when the app server starts (Next.js instrumentation).

export async function register() {
  // Node.js only (this file is also built for the edge runtime, where the
  // condition is false at build time and the import is left out).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Error alerts by e-mail (src/server/alerts.ts); off without recipients or SMTP.
    const { startAlerts } = await import('./server/alerts-start');
    startAlerts('app');
  }
}
