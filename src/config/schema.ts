import { z } from "zod";

export const ProviderSchema = z.enum(["ssh", "proxmox", "virtualizor"]);

export const BaseHostSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: ProviderSchema,
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  readOnly: z.boolean().optional().describe("Si true, solo tools de lectura en este host"),
  allowedTools: z.array(z.string()).optional().describe("Lista blanca de tools permitidas en este host"),
});

export const SshHostSchema = BaseHostSchema.extend({
  provider: z.literal("ssh"),
  host: z.string().min(1),
  port: z.number().int().positive().default(22),
  username: z.string().min(1),
  privateKeyPath: z.string().optional(),
  password: z.string().optional(),
  passphrase: z.string().optional(),
});

export const ProxmoxHostSchema = BaseHostSchema.extend({
  provider: z.literal("proxmox"),
  url: z.string().url(),
  tokenId: z.string().min(1),
  tokenSecret: z.string().min(1),
  verifySsl: z.boolean().default(true),
  defaultNode: z.string().optional(),
});

export const VirtualizorHostSchema = BaseHostSchema.extend({
  provider: z.literal("virtualizor"),
  url: z.string().url(),
  apiKey: z.string().min(1),
  apiPass: z.string().min(1),
  port: z.number().int().positive().optional(),
});

export const HostSchema = z.discriminatedUnion("provider", [
  SshHostSchema,
  ProxmoxHostSchema,
  VirtualizorHostSchema,
]);

export const InventorySchema = z.object({
  defaults: z
    .object({
      readOnly: z.boolean().optional(),
      requireConfirm: z.boolean().optional(),
    })
    .optional(),
  hosts: z.array(HostSchema).min(1),
});

export type Provider = z.infer<typeof ProviderSchema>;
export type SshHost = z.infer<typeof SshHostSchema>;
export type ProxmoxHost = z.infer<typeof ProxmoxHostSchema>;
export type VirtualizorHost = z.infer<typeof VirtualizorHostSchema>;
export type Host = z.infer<typeof HostSchema>;
export type Inventory = z.infer<typeof InventorySchema>;

export type VmType = "qemu" | "lxc" | "openvz" | "kvm" | "unknown";

export type VmSummary = {
  hostId: string;
  hostName: string;
  provider: Provider;
  vmId: string;
  name: string;
  status: string;
  type: VmType;
  node?: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  ip?: string;
  tags?: string[];
};

export type NodeSummary = {
  hostId: string;
  hostName: string;
  provider: Provider;
  nodeId: string;
  name: string;
  status: string;
  cpuUsage?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  uptime?: number;
};

export type VmPowerAction = "start" | "stop" | "shutdown" | "reboot" | "reset" | "suspend" | "resume";

export const HostIdSchema = z.object({
  hostId: z.string().min(1).describe("ID del host en el inventario"),
});

export const VmRefSchema = HostIdSchema.extend({
  vmId: z.string().min(1).describe("ID de la VM/VPS"),
  node: z.string().optional().describe("Nodo Proxmox (requerido para operaciones en Proxmox si no hay defaultNode)"),
  vmType: z.enum(["qemu", "lxc"]).optional().describe("Tipo de VM en Proxmox: qemu (KVM) o lxc"),
});

export const ConfirmSchema = z.object({
  confirm: z
    .boolean()
    .optional()
    .describe("Debe ser true para confirmar operaciones destructivas o lectura de paths sensibles"),
});

export const VmPowerSchema = VmRefSchema.merge(ConfirmSchema).extend({
  action: z.enum(["start", "stop", "shutdown", "reboot", "reset", "suspend", "resume"]),
});

export const SnapshotSchema = VmRefSchema.merge(ConfirmSchema).extend({
  snapname: z.string().min(1).describe("Nombre del snapshot"),
  description: z.string().optional(),
});

export const SshExecSchema = HostIdSchema.merge(ConfirmSchema).extend({
  command: z.string().min(1).describe("Comando a ejecutar"),
  cwd: z.string().optional().describe("Directorio de trabajo"),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});

export const SshReadFileSchema = HostIdSchema.merge(ConfirmSchema).extend({
  path: z.string().min(1).describe("Ruta absoluta del archivo"),
  maxBytes: z.number().int().positive().max(1_048_576).optional(),
});

export const ProviderFilterSchema = z.enum(["all", "ssh", "proxmox", "virtualizor"]).default("all");
