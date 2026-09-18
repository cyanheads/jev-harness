/**
 * src/client/index.ts — public surface of the client module.
 */
export {
  JevClient,
  type JevClientOptions,
  JevHttpError,
  type JevResult,
  PROVIDERS,
  type Provider,
  retryDelayMs,
  type State,
  stringifyEntries,
  USD_PER_INPUT_TOKEN,
} from './jev-client.ts';
