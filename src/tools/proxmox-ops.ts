import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, toolError } from "../api/utils.js";
import { listNetworkInfo } from "../providers/health.js";
import { ConfirmSchema, HostIdSchema, VmRefSchema } from "../config/schema.js";
import { guardToolAccess } from "../security/guard.js";
import { assertConfirmed } from "../security/policy.js";
import { ToolContext } from "./context.js";

export function registerProxmoxOpsTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "get-proxmox-task",
    {
      title: "Get Proxmox Task",
      description: "Consulta el estado de una tarea Proxmox por UPID (vzdump, snapshot, etc.).",
      inputSchema: HostIdSchema.extend({
        upid: z.string().min(1),
        node: z.string().optional(),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "get-proxmox-task", hostId: input.hostId, host, defaults: context.defaults });
        const client = context.registry.getProxmox(input.hostId);
        const node = client.resolveNode(input.node);
        const status = await client.getTaskStatus(node, input.upid);
        return jsonContent(status);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-storage-usage",
    {
      title: "List Storage Usage",
      description: "Lista storages Proxmox con uso de disco (cluster o nodo específico).",
      inputSchema: HostIdSchema.extend({ node: z.string().optional() }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "list-storage-usage", hostId: input.hostId, host, defaults: context.defaults });
        const client = context.registry.getProxmox(input.hostId);
        if (input.node) {
          const node = client.resolveNode(input.node);
          return jsonContent({ hostId: input.hostId, node, storages: await client.listStorageOnNode(node) });
        }
        return jsonContent({ hostId: input.hostId, storages: await client.listStorage() });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-backups",
    {
      title: "List Backups",
      description: "Lista tareas recientes de backup/vzdump en Proxmox.",
      inputSchema: HostIdSchema.extend({
        node: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "list-backups", hostId: input.hostId, host, defaults: context.defaults });
        const client = context.registry.getProxmox(input.hostId);
        const node = input.node ? client.resolveNode(input.node) : undefined;
        const backups = await client.listBackups(node, input.limit ?? 30);
        return jsonContent({ hostId: input.hostId, count: backups.length, backups });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create-backup",
    {
      title: "Create Backup",
      description: "Inicia vzdump en Proxmox. Requiere confirm=true y confirmToken.",
      inputSchema: VmRefSchema.merge(ConfirmSchema).extend({
        storage: z.string().optional(),
        mode: z.enum(["snapshot", "suspend", "stop"]).optional(),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "create-backup", hostId: input.hostId, host, defaults: context.defaults });
        assertConfirmed(input.confirm, input.confirmToken, "create-backup", `backup vm ${input.vmId}`, context.defaults);
        const client = context.registry.getProxmox(input.hostId);
        const node = client.resolveNode(input.node);
        const result = await client.createBackup(
          node,
          input.vmId,
          input.storage,
          input.mode ?? "snapshot",
          input.vmType ?? "qemu",
        );
        return jsonContent(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-network",
    {
      title: "List Network",
      description:
        "Red por proveedor: interfaces Proxmox, IPs Virtualizor/Hetzner, DNS Cloudflare (node=zoneId), ip addr en SSH.",
      inputSchema: HostIdSchema.extend({ node: z.string().optional() }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "list-network", hostId: input.hostId, host, defaults: context.defaults });
        const info = await listNetworkInfo(context.registry, input.hostId, input.node);
        return jsonContent(info);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
