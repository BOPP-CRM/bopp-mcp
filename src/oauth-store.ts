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

export type OAuthStoreSnapshot = {
  tokens: Record<string, StoredTokenData>;
  codes: Record<string, StoredCodeData>;
  clients: Record<string, OAuthClientInformationFull>;
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
    };
  } catch {
    return { tokens: {}, codes: {}, clients: {} };
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

  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(
    storePath,
    JSON.stringify({ tokens, codes, clients: snapshot.clients }, null, 2),
    "utf8",
  );
}
