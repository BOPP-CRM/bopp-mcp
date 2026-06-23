import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { requireEnvApiKey } from "./api.js";
import { createMcpServer } from "./server.js";
const apiKey = requireEnvApiKey();
const server = createMcpServer(apiKey);
const transport = new StdioServerTransport();
await server.connect(transport);
