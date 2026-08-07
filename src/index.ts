#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSysadminTools } from "./tools/index.js";

const server = new McpServer({
  name: "mcp-sysadmin",
  version: "1.5.0",
});

registerSysadminTools(server);

const transport = new StdioServerTransport();

server.connect(transport).catch((error) => {
  console.error("mcp-sysadmin failed to start:", error);
  process.exit(1);
});
