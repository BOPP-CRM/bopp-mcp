import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { verifyChallenge } from "pkce-challenge";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { createOAuthMetadata, mcpAuthMetadataRouter, } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidClientError, InvalidGrantError, InvalidRequestError, InvalidTokenError, OAuthError, ServerError, UnsupportedGrantTypeError, } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { validateApiKey } from "./api.js";
import { loadOAuthStore, saveOAuthStore, } from "./oauth-store.js";
export const DEFAULT_CLIENT_ID = "bopp";
export const CLAUDE_REDIRECT_URIS = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
];
const rateLimitOptions = {
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
};
const ACCESS_TOKEN_TTL_SEC = 3600;
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600;
class BoppClientsStore {
    dynamicClients = new Map();
    onChange;
    constructor(clients) {
        for (const [id, client] of Object.entries(clients)) {
            this.dynamicClients.set(id, client);
        }
    }
    setOnChange(onChange) {
        this.onChange = onChange;
    }
    snapshot() {
        return Object.fromEntries(this.dynamicClients);
    }
    async getClient(clientId) {
        if (clientId === DEFAULT_CLIENT_ID) {
            return {
                client_id: DEFAULT_CLIENT_ID,
                redirect_uris: [...CLAUDE_REDIRECT_URIS],
            };
        }
        const registered = this.dynamicClients.get(clientId);
        if (registered) {
            return registered;
        }
        // Claude may use a DCR client_id that isn't in our store (e.g. after store reset).
        // Accept any client_id and allow Claude's redirect URIs.
        return {
            client_id: clientId,
            redirect_uris: [...CLAUDE_REDIRECT_URIS],
        };
    }
    async registerClient(client) {
        const redirect_uris = [
            ...new Set([
                ...client.redirect_uris,
                ...CLAUDE_REDIRECT_URIS,
            ]),
        ];
        const registered = {
            ...client,
            redirect_uris,
            client_id: randomUUID(),
            client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.dynamicClients.set(registered.client_id, registered);
        this.onChange?.();
        return registered;
    }
}
function toStoredCode(code, data) {
    return [
        code,
        {
            client: data.client,
            params: {
                state: data.params.state,
                scopes: data.params.scopes,
                codeChallenge: data.params.codeChallenge,
                redirectUri: data.params.redirectUri,
                resource: data.params.resource?.href,
            },
            apiKey: data.apiKey,
        },
    ];
}
function fromStoredCode(data) {
    return {
        client: data.client,
        params: {
            state: data.params.state,
            scopes: data.params.scopes,
            codeChallenge: data.params.codeChallenge,
            redirectUri: data.params.redirectUri,
            resource: data.params.resource ? new URL(data.params.resource) : undefined,
        },
        apiKey: data.apiKey,
    };
}
function toStoredToken(token, data) {
    return [
        token,
        {
            apiKey: data.apiKey,
            clientId: data.clientId,
            scopes: data.scopes,
            expiresAt: data.expiresAt,
            resource: data.resource?.href,
            type: data.type,
        },
    ];
}
function fromStoredToken(data) {
    return {
        apiKey: data.apiKey,
        clientId: data.clientId,
        scopes: data.scopes,
        expiresAt: data.expiresAt,
        resource: data.resource ? new URL(data.resource) : undefined,
        type: data.type,
    };
}
export class BoppOAuthProvider {
    clientsStore;
    codes = new Map();
    tokens = new Map();
    constructor() {
        const snapshot = loadOAuthStore();
        this.clientsStore = new BoppClientsStore(snapshot.clients);
        this.clientsStore.setOnChange(() => this.persist());
        for (const [token, data] of Object.entries(snapshot.tokens)) {
            if (data.expiresAt > Date.now()) {
                this.tokens.set(token, fromStoredToken(data));
            }
        }
        for (const [code, data] of Object.entries(snapshot.codes)) {
            this.codes.set(code, fromStoredCode(data));
        }
    }
    persist() {
        saveOAuthStore({
            tokens: Object.fromEntries([...this.tokens.entries()].map(([token, data]) => toStoredToken(token, data))),
            codes: Object.fromEntries([...this.codes.entries()].map(([code, data]) => toStoredCode(code, data))),
            clients: this.clientsStore.snapshot(),
        });
    }
    async authorize(client, params, res, apiKey) {
        const code = randomUUID();
        this.codes.set(code, { client, params, apiKey });
        this.persist();
        const targetUrl = new URL(params.redirectUri);
        targetUrl.searchParams.set("code", code);
        if (params.state !== undefined) {
            targetUrl.searchParams.set("state", params.state);
        }
        res.redirect(targetUrl.toString());
    }
    getCodeData(authorizationCode) {
        return this.codes.get(authorizationCode);
    }
    getTokenData(token) {
        return this.tokens.get(token);
    }
    async challengeForAuthorizationCode(_client, authorizationCode) {
        const codeData = this.codes.get(authorizationCode);
        if (!codeData) {
            throw new InvalidGrantError("Invalid authorization code");
        }
        return codeData.params.codeChallenge;
    }
    async exchangeAuthorizationCode(client, authorizationCode, codeVerifier, _redirectUri, resource) {
        throw new UnsupportedGrantTypeError("Use exchangeAuthorizationCodeForApiKey with client_secret");
    }
    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
        throw new UnsupportedGrantTypeError("Use exchangeRefreshTokenForApiKey with client_secret");
    }
    async exchangeAuthorizationCodeForApiKey(client, authorizationCode, apiKey, codeVerifier, resource) {
        return this.issueTokensFromCode(client, authorizationCode, apiKey, codeVerifier, resource);
    }
    async exchangeRefreshTokenForApiKey(client, refreshToken, apiKey, scopes, resource) {
        const tokenData = this.tokens.get(refreshToken);
        if (!tokenData || tokenData.type !== "refresh") {
            throw new InvalidGrantError("Invalid refresh token");
        }
        if (tokenData.clientId !== client.client_id) {
            console.warn("[token] refresh client_id mismatch — token=%s request=%s", tokenData.clientId, client.client_id);
        }
        if (tokenData.expiresAt < Date.now()) {
            this.tokens.delete(refreshToken);
            this.persist();
            throw new InvalidGrantError("Refresh token has expired");
        }
        if (tokenData.apiKey !== apiKey) {
            throw new InvalidClientError("Invalid client_secret");
        }
        this.tokens.delete(refreshToken);
        return this.createTokenResponse(tokenData.clientId, apiKey, scopes ?? tokenData.scopes, resource ?? tokenData.resource);
    }
    async verifyAccessToken(token) {
        const tokenData = this.tokens.get(token);
        if (!tokenData || tokenData.type !== "access") {
            throw new InvalidTokenError("Invalid access token");
        }
        if (tokenData.expiresAt < Date.now()) {
            this.tokens.delete(token);
            this.persist();
            throw new InvalidTokenError("Access token has expired");
        }
        return {
            token,
            clientId: tokenData.clientId,
            scopes: tokenData.scopes,
            expiresAt: Math.floor(tokenData.expiresAt / 1000),
            resource: tokenData.resource,
            extra: { apiKey: tokenData.apiKey },
        };
    }
    async issueTokensFromCode(client, authorizationCode, apiKey, codeVerifier, resource) {
        const codeData = this.codes.get(authorizationCode);
        if (!codeData) {
            throw new InvalidGrantError("Invalid authorization code");
        }
        // Claude may send a different client_id at /token vs /authorize (DCR uuid vs configured "bopp")
        const issuingClient = codeData.client.client_id === client.client_id
            ? client
            : codeData.client;
        if (issuingClient !== client) {
            console.warn("[token] client_id mismatch — authorize=%s token=%s", codeData.client.client_id, client.client_id);
        }
        if (codeVerifier) {
            const valid = await verifyChallenge(codeVerifier, codeData.params.codeChallenge);
            if (!valid) {
                throw new InvalidGrantError("code_verifier does not match the challenge");
            }
        }
        this.codes.delete(authorizationCode);
        return this.createTokenResponse(issuingClient.client_id, apiKey, codeData.params.scopes ?? [], resource ?? codeData.params.resource);
    }
    createTokenResponse(clientId, apiKey, scopes, resource) {
        const accessToken = randomUUID();
        const refreshToken = randomUUID();
        const now = Date.now();
        this.tokens.set(accessToken, {
            apiKey,
            clientId,
            scopes,
            expiresAt: now + ACCESS_TOKEN_TTL_SEC * 1000,
            resource,
            type: "access",
        });
        this.tokens.set(refreshToken, {
            apiKey,
            clientId,
            scopes,
            expiresAt: now + REFRESH_TOKEN_TTL_SEC * 1000,
            resource,
            type: "refresh",
        });
        this.persist();
        const response = {
            access_token: accessToken,
            token_type: "bearer",
            expires_in: ACCESS_TOKEN_TTL_SEC,
            refresh_token: refreshToken,
            scope: scopes.join(" "),
        };
        if (resource) {
            response.resource = resource.href;
        }
        return response;
    }
}
async function resolveClient(clientsStore, clientId) {
    const client = await clientsStore.getClient(clientId);
    if (!client) {
        throw new InvalidClientError("Invalid client_id");
    }
    return client;
}
function parseClientCredentials(req) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Basic ")) {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator !== -1) {
            return {
                clientId: decoded.slice(0, separator),
                clientSecret: decoded.slice(separator + 1) || undefined,
            };
        }
    }
    return {
        clientId: req.body.client_id,
        clientSecret: req.body.client_secret || undefined,
    };
}
async function resolveApiKey(provider, options) {
    const { grantType, clientSecret, authorizationCode, refreshToken } = options;
    // Refresh: use API key stored with the refresh token (Claude may send a wrong client_secret)
    if (grantType === "refresh_token") {
        if (!refreshToken) {
            throw new InvalidRequestError("refresh_token is required");
        }
        const tokenData = provider.getTokenData(refreshToken);
        if (tokenData?.type === "refresh") {
            return tokenData.apiKey;
        }
        // Expected when Claude retries a stale refresh token after server/store reset
        console.log("[token] stale refresh_token");
        throw new InvalidGrantError("Invalid refresh token — reconnect the connector (server may have restarted)");
    }
    // Authorization code: prefer API key entered on the authorize page
    if (grantType === "authorization_code" && authorizationCode) {
        const apiKey = provider.getCodeData(authorizationCode)?.apiKey;
        if (apiKey) {
            return apiKey;
        }
    }
    if (clientSecret) {
        const valid = await validateApiKey(clientSecret);
        if (!valid) {
            throw new InvalidClientError("Invalid client_secret (BOPP API key)");
        }
        return clientSecret;
    }
    throw new InvalidClientError("Enter your BOPP API key on the authorization page, or set it in connector Advanced settings → OAuth Client Secret");
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
async function completeAuthorize(provider, req, res, apiKey) {
    const input = req.method === "POST" ? req.body : req.query;
    const clientId = input.client_id;
    if (!clientId || typeof clientId !== "string") {
        throw new InvalidRequestError("client_id is required");
    }
    const client = await resolveClient(provider.clientsStore, clientId);
    let redirectUri = input.redirect_uri;
    if (redirectUri !== undefined) {
        if (!client.redirect_uris.some((registered) => redirectUriMatches(String(redirectUri), registered))) {
            throw new InvalidRequestError("Unregistered redirect_uri");
        }
    }
    else if (client.redirect_uris.length === 1) {
        redirectUri = client.redirect_uris[0];
    }
    else {
        throw new InvalidRequestError("redirect_uri must be specified when client has multiple registered URIs");
    }
    const responseType = input.response_type;
    const codeChallenge = input.code_challenge;
    const codeChallengeMethod = input.code_challenge_method;
    if (responseType !== "code") {
        throw new InvalidRequestError("response_type must be code");
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
        throw new InvalidRequestError("PKCE S256 code_challenge is required");
    }
    const scope = input.scope;
    const scopes = scope ? String(scope).split(" ") : [];
    const state = input.state;
    const resource = input.resource;
    await provider.authorize(client, {
        state: state ? String(state) : undefined,
        scopes,
        redirectUri: String(redirectUri),
        codeChallenge: String(codeChallenge),
        resource: resource ? new URL(String(resource)) : undefined,
    }, res, apiKey);
}
function renderAuthorizeForm(params, error) {
    const hiddenFields = Object.entries(params)
        .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
        .join("\n    ");
    return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect BOPP CRM</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 24px; color: #111; }
    label { display: block; margin-bottom: 8px; font-weight: 600; }
    input[type=password] { width: 100%; padding: 10px; font-size: 16px; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 20px; font-size: 16px; cursor: pointer; width: 100%; }
    p { color: #555; line-height: 1.5; }
    .error { color: #b00020; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>Connect BOPP CRM</h1>
  <p>ใส่ BOPP API key เพื่อให้ Claude เข้าถึง CRM ของคุณ</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="/authorize">
    ${hiddenFields}
    <label for="api_key">BOPP API Key</label>
    <input id="api_key" name="api_key" type="password" required autocomplete="off" />
    <button type="submit">Connect</button>
  </form>
</body>
</html>`;
}
export function boppAuthorizeHandler(provider) {
    const router = express.Router();
    router.use(express.urlencoded({ extended: false }));
    router.use(rateLimit(rateLimitOptions));
    router.get("/", async (req, res) => {
        try {
            const params = {};
            for (const [key, value] of Object.entries(req.query)) {
                if (typeof value === "string") {
                    params[key] = value;
                }
            }
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(renderAuthorizeForm(params));
        }
        catch (error) {
            console.error("[authorize] GET error:", error);
            res.status(400).send("Invalid authorization request");
        }
    });
    router.post("/", async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try {
            const apiKey = req.body.api_key;
            if (!apiKey || typeof apiKey !== "string") {
                throw new InvalidRequestError("api_key is required");
            }
            const valid = await validateApiKey(apiKey);
            if (!valid) {
                const params = {};
                for (const [key, value] of Object.entries(req.body)) {
                    if (key !== "api_key" && typeof value === "string") {
                        params[key] = value;
                    }
                }
                res.status(400);
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.send(renderAuthorizeForm(params, "Invalid BOPP API key"));
                return;
            }
            await completeAuthorize(provider, req, res, apiKey);
        }
        catch (error) {
            if (error instanceof OAuthError) {
                console.error("[authorize]", error.errorCode, error.message);
                const status = error instanceof ServerError ? 500 : 400;
                res.status(status).json(error.toResponseObject());
                return;
            }
            console.error("[authorize] unexpected error:", error);
            res.status(500).send("Authorization failed");
        }
    });
    return router;
}
export function boppTokenHandler(provider) {
    const router = express.Router();
    router.use(cors());
    router.use(express.urlencoded({ extended: false }));
    router.use(rateLimit(rateLimitOptions));
    router.post("/", async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try {
            const grantType = req.body.grant_type;
            const { clientId, clientSecret } = parseClientCredentials(req);
            if (!grantType || !clientId) {
                throw new InvalidRequestError("grant_type and client_id are required");
            }
            console.log("[token] grant=%s client_id=%s", grantType, clientId);
            const client = await resolveClient(provider.clientsStore, clientId);
            switch (grantType) {
                case "authorization_code": {
                    const { code, code_verifier, resource } = req.body;
                    if (!code || !code_verifier) {
                        throw new InvalidRequestError("code and code_verifier are required");
                    }
                    const apiKey = await resolveApiKey(provider, {
                        grantType,
                        clientSecret,
                        authorizationCode: code,
                    });
                    const tokens = await provider.exchangeAuthorizationCodeForApiKey(client, code, apiKey, code_verifier, resource ? new URL(resource) : undefined);
                    res.status(200).json(tokens);
                    console.log("[token] ok grant=%s client_id=%s", grantType, clientId);
                    break;
                }
                case "refresh_token": {
                    const { refresh_token, scope, resource } = req.body;
                    if (!refresh_token) {
                        throw new InvalidRequestError("refresh_token is required");
                    }
                    const apiKey = await resolveApiKey(provider, {
                        grantType,
                        clientSecret,
                        refreshToken: refresh_token,
                    });
                    const tokens = await provider.exchangeRefreshTokenForApiKey(client, refresh_token, apiKey, scope ? String(scope).split(" ") : undefined, resource ? new URL(resource) : undefined);
                    res.status(200).json(tokens);
                    console.log("[token] ok grant=%s client_id=%s", grantType, clientId);
                    break;
                }
                default:
                    throw new UnsupportedGrantTypeError("The grant type is not supported by this authorization server");
            }
        }
        catch (error) {
            if (error instanceof OAuthError) {
                console.error("[token]", error.errorCode, error.message);
                const status = error instanceof ServerError ? 500 : 400;
                res.status(status).json(error.toResponseObject());
                return;
            }
            console.error("[token] unexpected error:", error);
            const serverError = new ServerError("Internal Server Error");
            res.status(500).json(serverError.toResponseObject());
        }
    });
    return router;
}
export function setupAuthRoutes(options) {
    const { app, provider, issuerUrl, mcpServerUrl } = options;
    const oauthMetadata = createOAuthMetadata({
        issuerUrl,
        provider,
        scopesSupported: ["mcp:tools"],
    });
    app.use(new URL(oauthMetadata.authorization_endpoint).pathname, boppAuthorizeHandler(provider));
    app.use(new URL(oauthMetadata.token_endpoint).pathname, boppTokenHandler(provider));
    if (oauthMetadata.registration_endpoint) {
        app.use(new URL(oauthMetadata.registration_endpoint).pathname, clientRegistrationHandler({ clientsStore: provider.clientsStore }));
    }
    app.use(mcpAuthMetadataRouter({
        oauthMetadata,
        resourceServerUrl: mcpServerUrl,
        scopesSupported: ["mcp:tools"],
        resourceName: "BOPP CRM MCP",
    }));
    return oauthMetadata;
}
