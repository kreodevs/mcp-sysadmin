import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, toolError } from "../api/utils.js";
import { runHealthCheck } from "../providers/health.js";
import { guardToolAccess } from "../security/guard.js";
import { ToolContext } from "./context.js";

const HealthSchema = z.object({
  hostId: z.string().optional().describe("Limitar a un host; si se omite, revisa todo el inventario"),
});

export function registerHealthTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "health-check",
    {
      title: "Health Check",
      description:
        "Revisión read-only de salud: SSH (disco/memoria), Proxmox (nodos/VMs), Virtualizor (VPS). " +
        "Devuelve healthy, degraded o unreachable por host.",
      inputSchema: HealthSchema,
    },
    async (input) => {
      try {
        const host = input.hostId ? context.registry.getHost(input.hostId) : undefined;
        guardToolAccess({
          toolName: "health-check",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });
        const results = await runHealthCheck(context.registry, input.hostId);
        const summary = {
          total: results.length,
          healthy: results.filter((r) => r.status === "healthy").length,
          degraded: results.filter((r) => r.status === "degraded").length,
          unreachable: results.filter((r) => r.status === "unreachable").length,
        };
        return jsonContent({ summary, results });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
