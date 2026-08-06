import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolContext } from "./context.js";
import { registerCloudflareTools } from "./cloudflare.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerHealthTools } from "./health.js";
import { registerHetznerOpsTools } from "./hetzner-ops.js";
import { registerInventoryTools } from "./inventory.js";
import { registerNodeTools } from "./nodes.js";
import { registerProxmoxOpsTools } from "./proxmox-ops.js";
import { registerSshTools } from "./ssh.js";
import { registerVmTools } from "./vms.js";

export function registerSysadminTools(server: McpServer) {
  const context = createToolContext();

  registerInventoryTools(server, context);
  registerNodeTools(server, context);
  registerVmTools(server, context);
  registerSshTools(server, context);
  registerHealthTools(server, context);
  registerProxmoxOpsTools(server, context);
  registerDiagnosticsTools(server, context);
  registerCloudflareTools(server, context);
  registerHetznerOpsTools(server, context);
}
