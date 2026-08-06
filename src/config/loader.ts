import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expandEnvDeep, getEnv, optionalEnv, SysadminError } from "../api/utils.js";
import { Host, HostSchema, Inventory, InventorySchema } from "./schema.js";

export class InventoryStore {
  private inventory: Inventory;

  constructor(inventory: Inventory) {
    this.inventory = inventory;
  }

  get defaults(): Inventory["defaults"] {
    return this.inventory.defaults;
  }

  static load(): InventoryStore {
    const path = resolve(
      optionalEnv("SYSADMIN_INVENTORY_PATH", "./config/inventory.json")!,
    );

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new SysadminError(
        `Cannot read inventory at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const expanded = expandEnvDeep(raw);
    const inventory = InventorySchema.parse(expanded);
    return new InventoryStore(inventory);
  }

  listHosts(filter: "all" | "ssh" | "proxmox" | "virtualizor" = "all"): Host[] {
    if (filter === "all") return this.inventory.hosts;
    return this.inventory.hosts.filter((host) => host.provider === filter);
  }

  getHost(hostId: string): Host {
    const host = this.inventory.hosts.find((item) => item.id === hostId);
    if (!host) {
      throw new SysadminError(`Host not found in inventory: ${hostId}`);
    }
    return host;
  }

  requireProvider<T extends Host["provider"]>(hostId: string, provider: T): Extract<Host, { provider: T }> {
    const host = this.getHost(hostId);
    if (host.provider !== provider) {
      throw new SysadminError(`Host ${hostId} is provider '${host.provider}', expected '${provider}'`);
    }
    return host as Extract<Host, { provider: T }>;
  }
}

export function getHttpTimeout(): number {
  return Number(optionalEnv("SYSADMIN_HTTP_TIMEOUT_MS", "30000"));
}

export function getSshTimeout(): number {
  return Number(optionalEnv("SYSADMIN_SSH_TIMEOUT_MS", "30000"));
}

// Re-export for tools that need validated host lookup
export { HostSchema };
