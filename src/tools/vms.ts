import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, toolError } from "../api/utils.js";
import { SnapshotSchema, VmPowerSchema, VmRefSchema } from "../config/schema.js";
import { guardToolAccess } from "../security/guard.js";
import {
  assertConfirmed,
  assertVmPowerAllowed,
} from "../security/policy.js";
import { isProductionMode } from "../security/startup.js";
import { sanitizeProxmoxVmPayload } from "../security/sanitize.js";
import { ToolContext } from "./context.js";

const ListVmsSchema = z.object({
  hostId: z.string().optional().describe("Limitar a un host del inventario"),
  node: z.string().optional().describe("Nodo Proxmox específico"),
  status: z.enum(["all", "running", "stopped"]).optional().describe("Filtrar por estado"),
});

export function registerVmTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "list-vms",
    {
      title: "List VMs",
      description:
        "Lista VMs/VPS/containers en Proxmox (qemu/lxc) y Virtualizor. " +
        "Si no se especifica hostId, agrega resultados de todos los hypervisors del inventario.",
      inputSchema: ListVmsSchema,
    },
    async (input) => {
      try {
        const host = input.hostId ? context.registry.getHost(input.hostId) : undefined;
        guardToolAccess({
          toolName: "list-vms",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        let vms = await context.registry.listAllVms(input.hostId, input.node);

        if (input.status === "running") {
          vms = vms.filter((vm) => ["running", "on", "started"].includes(vm.status.toLowerCase()));
        } else if (input.status === "stopped") {
          vms = vms.filter((vm) => ["stopped", "off"].includes(vm.status.toLowerCase()));
        }

        return jsonContent({ count: vms.length, vms });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get-vm",
    {
      title: "Get VM",
      description: "Obtiene detalle de una VM/VPS por hostId y vmId (campos sensibles redactados).",
      inputSchema: VmRefSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({
          toolName: "get-vm",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        if (host.provider === "proxmox") {
          const client = context.registry.getProxmox(input.hostId);
          const node = client.resolveNode(input.node);
          const vm = await client.getVm(node, input.vmId, input.vmType ?? "qemu");
          return jsonContent({
            hostId: vm.hostId,
            hostName: vm.hostName,
            provider: vm.provider,
            vmId: vm.vmId,
            name: vm.name,
            status: vm.status,
            type: vm.type,
            node: vm.node,
            cpu: vm.cpu,
            memoryMb: vm.memoryMb,
            diskGb: vm.diskGb,
            tags: vm.tags,
            config: sanitizeProxmoxVmPayload((vm.config ?? {}) as Record<string, unknown>),
            statusRaw: sanitizeProxmoxVmPayload((vm.statusRaw ?? {}) as Record<string, unknown>),
          });
        }

        if (host.provider === "virtualizor") {
          const vm = await context.registry.getVirtualizor(input.hostId).getVm(input.vmId);
          return jsonContent(vm);
        }

        return toolError(new Error(`Host ${input.hostId} does not manage VMs (provider: ${host.provider})`));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "vm-power",
    {
      title: "VM Power Action",
      description:
        "Acciones de energía en VMs: start, stop, shutdown, reboot, reset, suspend, resume. " +
        "Requiere confirm=true y confirmToken. En producción, todas las acciones requieren confirmación.",
      inputSchema: VmPowerSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({
          toolName: "vm-power",
          hostId: input.hostId,
          host,
          action: input.action,
          defaults: context.defaults,
        });

        assertVmPowerAllowed(input.action);

        const destructive = ["stop", "shutdown", "reboot", "reset"].includes(input.action);
        const needsConfirm = destructive || isProductionMode();
        if (needsConfirm) {
          assertConfirmed(
            input.confirm,
            input.confirmToken,
            "vm-power",
            `${input.action} vm ${input.vmId} on ${input.hostId}`,
            context.defaults,
          );
        }

        const result = await context.registry.vmPower(
          input.hostId,
          input.vmId,
          input.action,
          input.node,
          input.vmType,
        );
        return jsonContent(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-vm-snapshots",
    {
      title: "List VM Snapshots",
      description: "Lista snapshots de una VM en Proxmox (qemu o lxc).",
      inputSchema: VmRefSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({
          toolName: "list-vm-snapshots",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        if (host.provider !== "proxmox") {
          return toolError(new Error("Snapshots are only supported on Proxmox hosts"));
        }
        const client = context.registry.getProxmox(input.hostId);
        const node = client.resolveNode(input.node);
        const snapshots = await client.listSnapshots(node, input.vmId, input.vmType ?? "qemu");
        return jsonContent({ hostId: input.hostId, vmId: input.vmId, snapshots });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create-vm-snapshot",
    {
      title: "Create VM Snapshot",
      description: "Crea un snapshot en Proxmox para una VM (qemu o lxc). Requiere confirm=true.",
      inputSchema: SnapshotSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({
          toolName: "create-vm-snapshot",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        assertConfirmed(
          input.confirm,
          input.confirmToken,
          "create-vm-snapshot",
          `snapshot '${input.snapname}' on vm ${input.vmId}`,
          context.defaults,
        );

        if (host.provider !== "proxmox") {
          return toolError(new Error("Snapshots are only supported on Proxmox hosts"));
        }
        const client = context.registry.getProxmox(input.hostId);
        const node = client.resolveNode(input.node);
        const result = await client.createSnapshot(
          node,
          input.vmId,
          input.snapname,
          input.description,
          input.vmType ?? "qemu",
        );
        return jsonContent(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-proxmox-tasks",
    {
      title: "List Proxmox Tasks",
      description: "Lista tareas recientes en Proxmox (cluster o nodo específico).",
      inputSchema: z.object({
        hostId: z.string().min(1),
        node: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({
          toolName: "list-proxmox-tasks",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        const client = context.registry.getProxmox(input.hostId);
        const tasks = await client.listTasks(input.node, input.limit ?? 50);
        return jsonContent({ hostId: input.hostId, tasks });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
