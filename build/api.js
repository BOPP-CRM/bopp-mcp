import { getRequestApiKey } from "./context.js";
export const API_BASE = process.env.BOPP_API_BASE ?? "https://odoo-dev.bopp.digital/api";
export function requireEnvApiKey() {
    const apiKey = process.env.BOPP_API_KEY;
    if (!apiKey) {
        console.error("Missing BOPP_API_KEY environment variable");
        process.exit(1);
    }
    return apiKey;
}
export async function validateApiKey(apiKey) {
    const response = await fetch(`${API_BASE}/portal/me`, {
        headers: {
            "X-api-key": apiKey,
            "content-type": "application/json",
        },
    });
    return response.ok;
}
export async function apiGet(path, query, apiKey) {
    const key = apiKey ?? getRequestApiKey();
    const url = new URL(`${API_BASE}${path}`);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
    }
    const response = await fetch(url, {
        headers: {
            "X-api-key": key,
            "content-type": "application/json",
        },
    });
    const text = await response.text();
    let data = text;
    try {
        data = text ? JSON.parse(text) : null;
    }
    catch {
        // keep raw text for non-JSON responses (e.g. export)
    }
    if (!response.ok) {
        return {
            content: [
                {
                    type: "text",
                    text: `HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
                },
            ],
            isError: true,
        };
    }
    return {
        content: [
            {
                type: "text",
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
            },
        ],
    };
}
