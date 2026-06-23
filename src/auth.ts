import { randomUUID } from "node:crypto";
import type { Response } from "express";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { verifyChallenge } from "pkce-challenge";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import {
  createOAuthMetadata,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
  OAuthError,
  ServerError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { validateApiKey } from "./api.js";
import { renderAuthorizeForm } from "./authorize-page.js";
import {
  loadOAuthStore,
  saveOAuthStore,
  type StoredCodeData,
  type StoredTokenData,
} from "./oauth-store.js";

export const DEFAULT_CLIENT_ID = "bopp";
export const CLAUDE_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

export const CHATGPT_REDIRECT_URIS = [
  "https://chatgpt.com/connector_platform_oauth_redirect",
] as const;

const KNOWN_REDIRECT_URIS = [
  ...CLAUDE_REDIRECT_URIS,
  ...CHATGPT_REDIRECT_URIS,
] as const;

const rateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
};

const ACCESS_TOKEN_TTL_SEC = Number(
  process.env.MCP_ACCESS_TOKEN_TTL_SEC ?? String(24 * 3600),
);
const REFRESH_TOKEN_TTL_SEC = Number(
  process.env.MCP_REFRESH_TOKEN_TTL_SEC ?? String(365 * 24 * 3600),
);

type CodeData = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  apiKey?: string;
};

type TokenData = {
  apiKey: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
  type: "access" | "refresh";
};

class BoppClientsStore implements OAuthRegisteredClientsStore {
  private readonly dynamicClients = new Map<string, OAuthClientInformationFull>();
  private onChange?: () => void;

  constructor(clients: Record<string, OAuthClientInformationFull>) {
    for (const [id, client] of Object.entries(clients)) {
      this.dynamicClients.set(id, client);
    }
  }

  setOnChange(onChange: () => void): void {
    this.onChange = onChange;
  }

  snapshot(): Record<string, OAuthClientInformationFull> {
    return Object.fromEntries(this.dynamicClients);
  }

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    if (clientId === DEFAULT_CLIENT_ID) {
      return {
        client_id: DEFAULT_CLIENT_ID,
        redirect_uris: [...KNOWN_REDIRECT_URIS],
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
      redirect_uris: [...KNOWN_REDIRECT_URIS],
    };
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const redirect_uris = [
      ...new Set([
        ...client.redirect_uris,
        ...KNOWN_REDIRECT_URIS,
      ]),
    ];
    const registered: OAuthClientInformationFull = {
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

function toStoredCode(code: string, data: CodeData): [string, StoredCodeData] {
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

function fromStoredCode(data: StoredCodeData): CodeData {
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

function toStoredToken(token: string, data: TokenData): [string, StoredTokenData] {
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

function fromStoredToken(data: StoredTokenData): TokenData {
  return {
    apiKey: data.apiKey,
    clientId: data.clientId,
    scopes: data.scopes,
    expiresAt: data.expiresAt,
    resource: data.resource ? new URL(data.resource) : undefined,
    type: data.type,
  };
}

export class BoppOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: BoppClientsStore;

  private readonly codes = new Map<string, CodeData>();
  private readonly tokens = new Map<string, TokenData>();
  private readonly clientApiKeys = new Map<string, { apiKey: string; expiresAt: number }>();

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

    for (const [clientId, data] of Object.entries(snapshot.clientApiKeys ?? {})) {
      if (data.expiresAt > Date.now()) {
        this.clientApiKeys.set(clientId, data);
      }
    }
  }

  private persist(): void {
    saveOAuthStore({
      tokens: Object.fromEntries(
        [...this.tokens.entries()].map(([token, data]) => toStoredToken(token, data)),
      ),
      codes: Object.fromEntries(
        [...this.codes.entries()].map(([code, data]) => toStoredCode(code, data)),
      ),
      clients: this.clientsStore.snapshot(),
      clientApiKeys: Object.fromEntries(this.clientApiKeys),
    });
  }

  rememberClientApiKey(clientId: string, apiKey: string): void {
    this.clientApiKeys.set(clientId, {
      apiKey,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_SEC * 1000,
    });
    this.persist();
  }

  getClientApiKey(clientId: string): string | undefined {
    const cached = this.clientApiKeys.get(clientId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.apiKey;
    }

    const snapshot = loadOAuthStore();
    const stored = snapshot.clientApiKeys?.[clientId];
    if (!stored || stored.expiresAt <= Date.now()) {
      return undefined;
    }

    this.clientApiKeys.set(clientId, stored);
    return stored.apiKey;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
    apiKey?: string,
  ): Promise<void> {
    const code = randomUUID();
    this.codes.set(code, { client, params, apiKey });
    if (apiKey) {
      this.rememberClientApiKey(client.client_id, apiKey);
    }
    this.persist();

    const targetUrl = new URL(params.redirectUri);
    targetUrl.searchParams.set("code", code);
    if (params.state !== undefined) {
      targetUrl.searchParams.set("state", params.state);
    }

    res.redirect(targetUrl.toString());
  }

  getCodeData(authorizationCode: string): CodeData | undefined {
    return this.getCodeOrLoad(authorizationCode);
  }

  private getCodeOrLoad(code: string): CodeData | undefined {
    const cached = this.codes.get(code);
    if (cached) {
      return cached;
    }

    const snapshot = loadOAuthStore();
    const stored = snapshot.codes[code];
    if (!stored) {
      return undefined;
    }

    const data = fromStoredCode(stored);
    this.codes.set(code, data);
    return data;
  }

  private getTokenOrLoad(token: string): TokenData | undefined {
    const cached = this.tokens.get(token);
    if (cached) {
      return cached;
    }

    const snapshot = loadOAuthStore();
    const stored = snapshot.tokens[token];
    if (!stored || stored.expiresAt <= Date.now()) {
      return undefined;
    }

    const data = fromStoredToken(stored);
    this.tokens.set(token, data);
    return data;
  }

  getTokenData(token: string): TokenData | undefined {
    return this.getTokenOrLoad(token);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeData = this.getCodeOrLoad(authorizationCode);
    if (!codeData) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError(
      "Use exchangeAuthorizationCodeForApiKey with client_secret",
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError(
      "Use exchangeRefreshTokenForApiKey with client_secret",
    );
  }

  async exchangeAuthorizationCodeForApiKey(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    apiKey: string,
    codeVerifier?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.issueTokensFromCode(
      client,
      authorizationCode,
      apiKey,
      codeVerifier,
      resource,
    );
  }

  async exchangeRefreshTokenForApiKey(
    client: OAuthClientInformationFull,
    refreshToken: string,
    apiKey: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenData = this.getTokenOrLoad(refreshToken);

    if (!tokenData || tokenData.type !== "refresh") {
      throw new InvalidGrantError("Invalid refresh token");
    }

    if (tokenData.clientId !== client.client_id) {
      console.warn(
        "[token] refresh client_id mismatch — token=%s request=%s",
        tokenData.clientId,
        client.client_id,
      );
    }

    if (tokenData.expiresAt < Date.now()) {
      this.tokens.delete(refreshToken);
      this.persist();
      throw new InvalidGrantError("Refresh token has expired");
    }

    if (tokenData.apiKey !== apiKey) {
      throw new InvalidClientError("Invalid client_secret");
    }

    return this.renewAccessToken(
      refreshToken,
      tokenData,
      scopes ?? tokenData.scopes,
      resource ?? tokenData.resource,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenData = this.getTokenOrLoad(token);

    if (!tokenData || tokenData.type !== "access") {
      console.warn("[auth] invalid access token");
      throw new InvalidTokenError("Invalid access token");
    }

    if (tokenData.expiresAt < Date.now()) {
      this.tokens.delete(token);
      this.persist();
      throw new InvalidTokenError("Access token has expired");
    }

    if (!tokenData.apiKey) {
      console.warn("[auth] access token missing apiKey — reconnect required");
      throw new InvalidTokenError("Access token is missing credentials");
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

  private async issueTokensFromCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    apiKey: string,
    codeVerifier?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeData = this.getCodeOrLoad(authorizationCode);
    if (!codeData) {
      throw new InvalidGrantError("Invalid authorization code");
    }

    // Claude may send a different client_id at /token vs /authorize (DCR uuid vs configured "bopp")
    const issuingClient =
      codeData.client.client_id === client.client_id
        ? client
        : codeData.client;
    if (issuingClient !== client) {
      console.warn(
        "[token] client_id mismatch — authorize=%s token=%s",
        codeData.client.client_id,
        client.client_id,
      );
    }

    if (codeVerifier) {
      const valid = await verifyChallenge(
        codeVerifier,
        codeData.params.codeChallenge,
      );
      if (!valid) {
        throw new InvalidGrantError("code_verifier does not match the challenge");
      }
    }

    this.codes.delete(authorizationCode);
    return this.createTokenResponse(
      issuingClient.client_id,
      apiKey,
      codeData.params.scopes ?? [],
      resource ?? codeData.params.resource,
    );
  }

  private createTokenResponse(
    clientId: string,
    apiKey: string,
    scopes: string[],
    resource?: URL,
  ): OAuthTokens {
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

    const response: OAuthTokens & { resource?: string } = {
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

  /** Refresh: issue a new access token but keep the same refresh token (rolling expiry). */
  private renewAccessToken(
    refreshToken: string,
    refreshData: TokenData,
    scopes: string[],
    resource?: URL,
  ): OAuthTokens {
    const accessToken = randomUUID();
    const now = Date.now();

    this.tokens.set(accessToken, {
      apiKey: refreshData.apiKey,
      clientId: refreshData.clientId,
      scopes,
      expiresAt: now + ACCESS_TOKEN_TTL_SEC * 1000,
      resource,
      type: "access",
    });

    // Rolling refresh: extend session on each refresh instead of rotating the token
    this.tokens.set(refreshToken, {
      apiKey: refreshData.apiKey,
      clientId: refreshData.clientId,
      scopes,
      expiresAt: now + REFRESH_TOKEN_TTL_SEC * 1000,
      resource,
      type: "refresh",
    });

    this.persist();

    const response: OAuthTokens & { resource?: string } = {
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

async function resolveClient(
  clientsStore: OAuthRegisteredClientsStore,
  clientId: string,
): Promise<OAuthClientInformationFull> {
  const client = await clientsStore.getClient(clientId);
  if (!client) {
    throw new InvalidClientError("Invalid client_id");
  }
  return client;
}

function parseClientCredentials(
  req: express.Request,
): { clientId: string; clientSecret?: string } {
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

async function resolveApiKey(
  provider: BoppOAuthProvider,
  options: {
    grantType: string;
    clientId?: string;
    clientSecret?: string;
    authorizationCode?: string;
    refreshToken?: string;
  },
): Promise<string> {
  const { grantType, clientId, clientSecret, authorizationCode, refreshToken } =
    options;

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
    throw new InvalidGrantError(
      "Invalid refresh token — reconnect the connector (server may have restarted)",
    );
  }

  // Authorization code: prefer API key entered on the authorize page
  if (grantType === "authorization_code" && authorizationCode) {
    const apiKey = provider.getCodeData(authorizationCode)?.apiKey;
    if (apiKey) {
      return apiKey;
    }
  }

  if (grantType === "authorization_code" && clientId) {
    const remembered = provider.getClientApiKey(clientId);
    if (remembered) {
      return remembered;
    }
  }

  if (clientSecret) {
    const valid = await validateApiKey(clientSecret);
    if (!valid) {
      throw new InvalidClientError("Invalid client_secret (BOPP API key)");
    }
    return clientSecret;
  }

  throw new InvalidClientError(
    "Enter your BOPP API key on the authorization page, or set it in connector Advanced settings → OAuth Client Secret",
  );
}

function isAllowedRedirectUri(requested: string, registered: string): boolean {
  if (redirectUriMatches(requested, registered)) {
    return true;
  }

  try {
    const url = new URL(requested);
    if (
      url.origin === "https://chatgpt.com" &&
      url.pathname.startsWith("/connector/oauth/")
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function completeAuthorize(
  provider: BoppOAuthProvider,
  req: express.Request,
  res: Response,
  apiKey?: string,
): Promise<void> {
  const input = req.method === "POST" ? req.body : req.query;
  const clientId = input.client_id;
  if (!clientId || typeof clientId !== "string") {
    throw new InvalidRequestError("client_id is required");
  }

  const client = await resolveClient(provider.clientsStore, clientId);

  let redirectUri = input.redirect_uri;
  if (redirectUri !== undefined) {
    if (
      !client.redirect_uris.some((registered) =>
        isAllowedRedirectUri(String(redirectUri), registered),
      )
    ) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }
  } else if (client.redirect_uris.length === 1) {
    redirectUri = client.redirect_uris[0];
  } else {
    throw new InvalidRequestError(
      "redirect_uri must be specified when client has multiple registered URIs",
    );
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

  await provider.authorize(
    client,
    {
      state: state ? String(state) : undefined,
      scopes,
      redirectUri: String(redirectUri),
      codeChallenge: String(codeChallenge),
      resource: resource ? new URL(String(resource)) : undefined,
    },
    res,
    apiKey,
  );
}

export function boppAuthorizeHandler(provider: BoppOAuthProvider) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(rateLimit(rateLimitOptions));

  router.get("/", async (req, res) => {
    try {
      const clientId = req.query.client_id;
      if (typeof clientId === "string") {
        const remembered = provider.getClientApiKey(clientId);
        if (remembered) {
          console.log("[authorize] auto client_id=%s", clientId);
          await completeAuthorize(provider, req, res, remembered);
          return;
        }
      }

      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === "string") {
          params[key] = value;
        }
      }

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderAuthorizeForm(params));
    } catch (error) {
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
        const params: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.body)) {
          if (key !== "api_key" && typeof value === "string") {
            params[key] = value;
          }
        }
        res.status(400);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(renderAuthorizeForm(params, "API key ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่"));
        return;
      }

      await completeAuthorize(provider, req, res, apiKey);
    } catch (error) {
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

export function boppTokenHandler(provider: BoppOAuthProvider) {
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
            clientId,
            clientSecret,
            authorizationCode: code,
          });
          const tokens = await provider.exchangeAuthorizationCodeForApiKey(
            client,
            code,
            apiKey,
            code_verifier,
            resource ? new URL(resource) : undefined,
          );
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
          const tokens = await provider.exchangeRefreshTokenForApiKey(
            client,
            refresh_token,
            apiKey,
            scope ? String(scope).split(" ") : undefined,
            resource ? new URL(resource) : undefined,
          );
          res.status(200).json(tokens);
          console.log("[token] ok grant=%s client_id=%s", grantType, clientId);
          break;
        }
        default:
          throw new UnsupportedGrantTypeError(
            "The grant type is not supported by this authorization server",
          );
      }
    } catch (error) {
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

export function setupAuthRoutes(options: {
  app: express.Express;
  provider: BoppOAuthProvider;
  issuerUrl: URL;
  mcpServerUrl: URL;
}) {
  const { app, provider, issuerUrl, mcpServerUrl } = options;

  const oauthMetadata = createOAuthMetadata({
    issuerUrl,
    provider,
    scopesSupported: ["mcp:tools"],
  });

  app.use(
    new URL(oauthMetadata.authorization_endpoint).pathname,
    boppAuthorizeHandler(provider),
  );
  app.use(
    new URL(oauthMetadata.token_endpoint).pathname,
    boppTokenHandler(provider),
  );

  if (oauthMetadata.registration_endpoint) {
    app.use(
      new URL(oauthMetadata.registration_endpoint).pathname,
      clientRegistrationHandler({ clientsStore: provider.clientsStore }),
    );
  }

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: mcpServerUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "BOPP CRM MCP",
    }),
  );

  return oauthMetadata;
}
