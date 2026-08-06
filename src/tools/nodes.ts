import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, toolError } from "../api/utils.js";
import { HostIdSchema } from "../config/schema.js";
import { guardToolAccess } from "../security/guard.js";
import { ToolContext } from "./context.js";

const ListNodesSchema = z.object({
  hostId: z.string().optional().describe("Limitar a un host del inventario"),
});

const NodeStatusSchema = HostIdSchema.extend({
  nodeId: z.string().optional().describe("ID del nodo (Proxmox node o Virtualizor server). En SSH usa el hostId."),
});

export function registerNodeTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "list-nodes",
    {
      title: "List Nodes",
      description:
        "Lista nodos/hypervisors: nodos de cluster Proxmox, servidores en Virtualizor, o hosts SSH como nodos individuales.",
      inputSchema: ListNodesSchema,
    },
    async (input) => {
      try {
        const host = input.hostId ? context.registry.getHost(input.hostId) : undefined;
        guardToolAccess({
          toolName: "list-nodes",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });
        const nodes = await context.registry.listAllNodes(input.hostId);
        return jsonContent({ count: nodes.length, nodes });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get-node-status",
    {
      title: "Get Node Status",
      description: "Obtiene métricas de un nodo: CPU, memoria, uptime (Proxmox/Virtualizor) o stats vía SSH en servidores físicos.",
      inputSchema: NodeStatusSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({
          toolName: "get-node-status",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        if (host.provider === "proxmox") {
          const client = context.registry.getProxmox(input.hostId);
          const node = input.nodeId ?? client.resolveNode();
          const status = await client.getNodeStatus(node);
          return jsonContent(status);
        }

        if (host.provider === "virtualizor") {
          const client = context.registry.getVirtualizor(input.hostId);
          const nodeId = input.nodeId;
          if (!nodeId) {
            const nodes = await client.listNodes();
            return jsonContent({ hostId: input.hostId, nodes });
          }
          const status = await client.getNodeStatus(nodeId);
          return jsonContent(status);
        }

        if (host.provider === "ssh") {
          const sshHost = context.registry.getSsh(input.hostId);
          const stats = await context.registry.ssh().getHostStats(sshHost);
          return jsonContent(stats);
        }

        return toolError(new Error(`Unsupported provider for host ${input.hostId}`));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
