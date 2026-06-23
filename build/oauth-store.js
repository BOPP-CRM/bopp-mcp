import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const storePath = process.env.MCP_OAUTH_STORE ??
    new URL("../.mcp-oauth-store.json", import.meta.url).pathname;
export function loadOAuthStore() {
    try {
        const raw = readFileSync(storePath, "utf8");
        const data = JSON.parse(raw);
        return {
            tokens: data.tokens ?? {},
            codes: data.codes ?? {},
            clients: data.clients ?? {},
        };
    }
    catch {
        return { tokens: {}, codes: {}, clients: {} };
    }
}
export function saveOAuthStore(snapshot) {
    const now = Date.now();
    const tokens = {};
    for (const [key, value] of Object.entries(snapshot.tokens)) {
        if (value.expiresAt > now) {
            tokens[key] = value;
        }
    }
    const codes = {};
    for (const [key, value] of Object.entries(snapshot.codes)) {
        codes[key] = value;
    }
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify({ tokens, codes, clients: snapshot.clients }, null, 2), "utf8");
}
