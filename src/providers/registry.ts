import { InventoryStore } from "../config/loader.js";
import {
  CloudflareHost,
  HetznerHost,
  Host,
  NodeSummary,
  ProxmoxHost,
  Provider,
  SshHost,
  VirtualizorHost,
  VmPowerAction,
  VmSummary,
  VmType,
} from "../config/schema.js";
import { hostAllowsTool } from "../security/policy.js";
import { CloudflareClient } from "./cloudflare/client.js";
import { HetznerClient } from "./hetzner/client.js";
import { ProxmoxClient } from "./proxmox/client.js";
import { SshClient } from "./ssh/client.js";
import { SshDiagnostics } from "./ssh/diagnostics.js";
import { VirtualizorClient } from "./virtualizor/client.js";

export class ProviderRegistry {
  private readonly inventory: InventoryStore;
  private readonly proxmoxClients = new Map<string, ProxmoxClient>();
  private readonly virtualizorClients = new Map<string, VirtualizorClient>();
  private readonly hetznerClients = new Map<string, HetznerClient>();
  private readonly cloudflareClients = new Map<string, CloudflareClient>();
  private readonly sshClient = new SshClient();
  private readonly sshDiagnostics: SshDiagnostics;

  constructor(inventory: InventoryStore) {
    this.inventory = inventory;
    this.sshDiagnostics = new SshDiagnostics(this.sshClient);
  }

  listHosts(filter: Provider | "all" = "all"): Host[] {
    return this.inventory.listHosts(filter);
  }

  getHost(hostId: string): Host {
    return this.inventory.getHost(hostId);
  }

  getProxmox(hostId: string): ProxmoxClient {
    let client = this.proxmoxClients.get(hostId);
    if (!client) {
      const host = this.inventory.requireProvider(hostId, "proxmox") as ProxmoxHost;
      client = new ProxmoxClient(host);
      this.proxmoxClients.set(hostId, client);
    }
    return client;
  }

  getVirtualizor(hostId: string): VirtualizorClient {
    let client = this.virtualizorClients.get(hostId);
    if (!client) {
      const host = this.inventory.requireProvider(hostId, "virtualizor") as VirtualizorHost;
      client = new VirtualizorClient(host);
      this.virtualizorClients.set(hostId, client);
    }
    return client;
  }

  getHetzner(hostId: string): HetznerClient {
    let client = this.hetznerClients.get(hostId);
    if (!client) {
      const host = this.inventory.requireProvider(hostId, "hetzner") as HetznerHost;
      client = new HetznerClient(host);
      this.hetznerClients.set(hostId, client);
    }
    return client;
  }

  getCloudflare(hostId: string): CloudflareClient {
    let client = this.cloudflareClients.get(hostId);
    if (!client) {
      const host = this.inventory.requireProvider(hostId, "cloudflare") as CloudflareHost;
      client = new CloudflareClient(host);
      this.cloudflareClients.set(hostId, client);
    }
    return client;
  }

  getSsh(hostId: string): SshHost {
    return this.inventory.requireProvider(hostId, "ssh");
  }

  async listAllNodes(hostId?: string, toolName = "list-nodes"): Promise<NodeSummary[]> {
    const hosts = hostId ? [this.getHost(hostId)] : this.listHosts().filter((h) => hostAllowsTool(h, toolName));
    const results: NodeSummary[] = [];

    for (const host of hosts) {
      if (host.provider === "proxmox") {
        results.push(...(await this.getProxmox(host.id).listNodes()));
      } else if (host.provider === "virtualizor") {
        results.push(...(await this.getVirtualizor(host.id).listNodes()));
      } else if (host.provider === "hetzner") {
        results.push(...(await this.getHetzner(host.id).listNodes()));
      } else if (host.provider === "ssh") {
        results.push({
          hostId: host.id,
          hostName: host.name,
          provider: "ssh",
          nodeId: host.id,
          name: host.name,
          status: "reachable",
        });
      }
    }

    return results;
  }

  async listAllVms(hostId?: string, node?: string, toolName = "list-vms"): Promise<VmSummary[]> {
    const hosts = hostId ? [this.getHost(hostId)] : this.listHosts().filter((h) => hostAllowsTool(h, toolName));
    const results: VmSummary[] = [];

    for (const host of hosts) {
      if (host.provider === "proxmox") {
        results.push(...(await this.getProxmox(host.id).listVms(node)));
      } else if (host.provider === "virtualizor") {
        results.push(...(await this.getVirtualizor(host.id).listVms()));
      } else if (host.provider === "hetzner") {
        results.push(...(await this.getHetzner(host.id).listVms(node)));
      }
    }

    return results;
  }

  async vmPower(hostId: string, vmId: string, action: VmPowerAction, node?: string, vmType?: VmType) {
    const host = this.getHost(hostId);
    if (host.provider === "proxmox") {
      const client = this.getProxmox(hostId);
      const resolvedNode = client.resolveNode(node);
      return client.vmPower(resolvedNode, vmId, action, vmType ?? "qemu");
    }
    if (host.provider === "virtualizor") {
      return this.getVirtualizor(hostId).vmPower(vmId, action);
    }
    if (host.provider === "hetzner") {
      return this.getHetzner(hostId).vmPower(vmId, action);
    }
    throw new Error(`Host ${hostId} (${host.provider}) does not manage VMs`);
  }

  ssh() {
    return this.sshClient;
  }

  sshDiag() {
    return this.sshDiagnostics;
  }
}
