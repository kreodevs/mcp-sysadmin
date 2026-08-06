import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, toolError } from "../api/utils.js";
import { ProviderFilterSchema } from "../config/schema.js";
import { guardToolAccess } from "../security/guard.js";
import { sanitizeHostRecord } from "../security/sanitize.js";
import { ToolContext } from "./context.js";

const InputSchema = z.object({
  provider: ProviderFilterSchema.optional().describe("Filtrar por tipo de proveedor"),
  tag: z.string().optional().describe("Filtrar hosts que contengan este tag"),
});

export function registerInventoryTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "list-hosts",
    {
      title: "List Hosts",
      description:
        "Lista todos los hosts del inventario (servidores físicos SSH, nodos Proxmox, paneles Virtualizor). " +
        "El inventario es agnóstico de proveedor: cada host tiene id, provider y credenciales propias.",
      inputSchema: InputSchema,
    },
    async (input) => {
      try {
        guardToolAccess({ toolName: "list-hosts", defaults: context.defaults });
        let hosts = context.registry.listHosts(input.provider ?? "all");

        if (input.tag) {
          hosts = hosts.filter((host) => host.tags?.includes(input.tag!));
        }

        const sanitized = hosts.map((host) => sanitizeHostRecord(host as Record<string, unknown>));
        return jsonContent({ count: sanitized.length, hosts: sanitized });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get-host",
    {
      title: "Get Host",
      description: "Obtiene la configuración de un host del inventario por su ID (sin exponer secretos).",
      inputSchema: z.object({
        hostId: z.string().min(1),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "get-host", hostId: input.hostId, host, defaults: context.defaults });
        return jsonContent(sanitizeHostRecord(host as Record<string, unknown>));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
