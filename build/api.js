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
function formatApiResponse(response, data) {
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
async function parseResponseBody(response) {
    const text = await response.text();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
async function apiRequest(method, path, options) {
    const key = options?.apiKey ?? getRequestApiKey();
    const url = new URL(`${API_BASE}${path}`);
    if (options?.query) {
        for (const [param, value] of Object.entries(options.query)) {
            if (value !== undefined) {
                url.searchParams.set(param, String(value));
            }
        }
    }
    const response = await fetch(url, {
        method,
        headers: {
            "X-api-key": key,
            "content-type": "application/json",
        },
        ...(options?.body !== undefined
            ? { body: JSON.stringify(options.body) }
            : {}),
    });
    const data = await parseResponseBody(response);
    return formatApiResponse(response, data);
}
export async function apiGet(path, query, apiKey) {
    return apiRequest("GET", path, { query, apiKey });
}
export async function apiPost(path, body, apiKey) {
    return apiRequest("POST", path, { body, apiKey });
}
export async function apiPut(path, body, apiKey) {
    return apiRequest("PUT", path, { body, apiKey });
}
