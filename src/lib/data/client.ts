import { createBrowserDataClient } from '@/lib/db/browser-client';

export type DataClient = ReturnType<typeof createBrowserDataClient>;

let client: DataClient | undefined;

export function createClient(): DataClient {
  client ??= createBrowserDataClient();
  return client;
}
