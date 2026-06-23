import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BoppOAuthProvider, setupAuthRoutes } from "./auth.js";
import { createMcpServer } from "./server.js";
const port = Number(process.env.MCP_PORT ?? "3000");
const serverPublicUrl = new URL(process.env.MCP_SERVER_URL ?? `http://localhost:${port}`);
const issuerUrl = new URL(process.env.MCP_ISSUER_URL ?? serverPublicUrl.href);
const mcpServerUrl = new URL("/mcp", serverPublicUrl);
const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
const app = createMcpExpressApp({
    host: process.env.MCP_HOST ?? "0.0.0.0",
    ...(allowedHosts?.length ? { allowedHosts } : {}),
});
const assetDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "asset");
app.use("/asset", express.static(assetDir));
// Behind reverse proxy (nginx, Cloudflare, etc.) — required for rate-limit + correct client IP
const trustProxy = process.env.MCP_TRUST_PROXY ??
    (serverPublicUrl.protocol === "https:" ? "1" : "false");
if (trustProxy !== "false") {
    app.set("trust proxy", trustProxy === "true" ? 1 : Number(trustProxy) || 1);
}
const provider = new BoppOAuthProvider();
setupAuthRoutes({ app, provider, issuerUrl, mcpServerUrl });
const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
});
const transports = {};
function getApiKeyFromAuth(req) {
    const apiKey = req.auth?.extra?.apiKey;
    return typeof apiKey === "string" ? apiKey : undefined;
}
async function handleMcpRequest(req, res, handler) {
    const apiKey = getApiKeyFromAuth(req);
    if (!apiKey) {
        res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unauthorized" },
            id: null,
        });
        return;
    }
    await handler(apiKey);
}
const mcpPostHandler = async (req, res) => {
    await handleMcpRequest(req, res, async (apiKey) => {
        const sessionId = req.headers["mcp-session-id"];
        const method = req.body?.method;
        if (method) {
            console.log("[mcp] POST method=%s session=%s", method, sessionId ?? "new");
        }
        try {
            let transport;
            if (sessionId && transports[sessionId]) {
                transport = transports[sessionId];
            }
            else if (!sessionId && isInitializeRequest(req.body)) {
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => {
                        transports[id] = transport;
                    },
                });
                transport.onclose = () => {
                    const id = transport?.sessionId;
                    if (id && transports[id]) {
                        delete transports[id];
                    }
                };
                const server = createMcpServer(apiKey);
                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
                return;
            }
            else {
                res.status(400).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Bad Request: No valid session ID provided",
                    },
                    id: null,
                });
                return;
            }
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            console.error("Error handling MCP request:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });
};
const mcpGetHandler = async (req, res) => {
    await handleMcpRequest(req, res, async () => {
        const sessionId = req.headers["mcp-session-id"];
        if (!sessionId || !transports[sessionId]) {
            res.status(400).send("Invalid or missing session ID");
            return;
        }
        await transports[sessionId].handleRequest(req, res);
    });
};
const mcpDeleteHandler = async (req, res) => {
    await handleMcpRequest(req, res, async () => {
        const sessionId = req.headers["mcp-session-id"];
        if (!sessionId || !transports[sessionId]) {
            res.status(400).send("Invalid or missing session ID");
            return;
        }
        await transports[sessionId].handleRequest(req, res);
    });
};
app.post("/mcp", authMiddleware, mcpPostHandler);
app.get("/mcp", authMiddleware, mcpGetHandler);
app.delete("/mcp", authMiddleware, mcpDeleteHandler);
app.listen(port, () => {
    console.log(`BOPP MCP HTTP server listening on port ${port}`);
    console.log(`MCP endpoint: ${mcpServerUrl.href}`);
    console.log(`OAuth issuer: ${issuerUrl.href}`);
});
process.on("SIGINT", async () => {
    for (const sessionId of Object.keys(transports)) {
        try {
            await transports[sessionId].close();
            delete transports[sessionId];
        }
        catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    process.exit(0);
});
