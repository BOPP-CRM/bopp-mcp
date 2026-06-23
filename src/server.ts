import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

export function createMcpServer(apiKey: string): McpServer {
  const server = new McpServer({
    name: "bopp",
    version: "1.0.0",
  });

  registerTools(server, apiKey);
  return server;
}
