import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolContext } from "./context.js";
import { registerInventoryTools } from "./inventory.js";
import { registerNodeTools } from "./nodes.js";
import { registerSshTools } from "./ssh.js";
import { registerVmTools } from "./vms.js";

export function registerSysadminTools(server: McpServer) {
  const context = createToolContext();

  registerInventoryTools(server, context);
  registerNodeTools(server, context);
  registerVmTools(server, context);
  registerSshTools(server, context);
}
