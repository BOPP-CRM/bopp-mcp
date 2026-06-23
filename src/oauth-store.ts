import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export type StoredTokenData = {
  apiKey: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
  type: "access" | "refresh";
};

export type StoredCodeData = {
  client: OAuthClientInformationFull;
  params: {
    state?: string;
    scopes?: string[];
    codeChallenge: string;
    redirectUri: string;
    resource?: string;
  };
  apiKey?: string;
};

export type StoredClientApiKey = {
  apiKey: string;
  expiresAt: number;
};

export type OAuthStoreSnapshot = {
  tokens: Record<string, StoredTokenData>;
  codes: Record<string, StoredCodeData>;
  clients: Record<string, OAuthClientInformationFull>;
  clientApiKeys?: Record<string, StoredClientApiKey>;
};

const storePath =
  process.env.MCP_OAUTH_STORE ??
  new URL("../.mcp-oauth-store.json", import.meta.url).pathname;

export function loadOAuthStore(): OAuthStoreSnapshot {
  try {
    const raw = readFileSync(storePath, "utf8");
    const data = JSON.parse(raw) as OAuthStoreSnapshot;
    return {
      tokens: data.tokens ?? {},
      codes: data.codes ?? {},
      clients: data.clients ?? {},
      clientApiKeys: data.clientApiKeys ?? {},
    };
  } catch {
    return { tokens: {}, codes: {}, clients: {}, clientApiKeys: {} };
  }
}

export function saveOAuthStore(snapshot: OAuthStoreSnapshot): void {
  const now = Date.now();
  const tokens: Record<string, StoredTokenData> = {};
  for (const [key, value] of Object.entries(snapshot.tokens)) {
    if (value.expiresAt > now) {
      tokens[key] = value;
    }
  }

  const codes: Record<string, StoredCodeData> = {};
  for (const [key, value] of Object.entries(snapshot.codes)) {
    codes[key] = value;
  }

  const clientApiKeys: Record<string, StoredClientApiKey> = {};
  for (const [key, value] of Object.entries(snapshot.clientApiKeys ?? {})) {
    if (value.expiresAt > now) {
      clientApiKeys[key] = value;
    }
  }

  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(
    storePath,
    JSON.stringify(
      { tokens, codes, clients: snapshot.clients, clientApiKeys },
      null,
      2,
    ),
    "utf8",
  );
}
