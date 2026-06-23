import { AsyncLocalStorage } from "node:async_hooks";

const apiKeyStorage = new AsyncLocalStorage<string>();

export function getRequestApiKey(): string {
  const key = apiKeyStorage.getStore();
  if (key) {
    return key;
  }

  const envKey = process.env.BOPP_API_KEY;
  if (envKey) {
    return envKey;
  }

  throw new Error("No API key in request context");
}

export function runWithApiKey<T>(apiKey: string, fn: () => T): T {
  return apiKeyStorage.run(apiKey, fn);
}
