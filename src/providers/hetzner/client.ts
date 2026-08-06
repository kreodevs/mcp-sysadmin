import axios, { AxiosInstance } from "axios";
import {
  firstNumber,
  firstString,
  JsonRecord,
  SysadminError,
  toArray,
} from "../../api/utils.js";
import { getHttpTimeout } from "../../config/loader.js";
import { HetznerHost, NodeSummary, VmPowerAction, VmSummary } from "../../config/schema.js";

type HetznerListResponse<T> = {
  [key: string]: T[] | unknown;
  meta?: { pagination?: { next_page?: number | null } };
};

export class HetznerClient {
  private readonly http: AxiosInstance;
  private readonly host: HetznerHost;

  constructor(host: HetznerHost) {
    this.host = host;
    this.http = axios.create({
      baseURL: "https://api.hetzner.cloud/v1",
      timeout: getHttpTimeout(),
      headers: {
        Authorization: `Bearer ${host.apiToken}`,
        Accept: "application/json",
      },
    });
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    data?: unknown,
  ): Promise<T> {
    try {
      const response = await this.http.request({ method, url: path, data });
      return response.data as T;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const body = error.response?.data as JsonRecord | undefined;
        const message =
          body?.error && typeof body.error === "object"
            ? firstString(body.error as JsonRecord, ["message"], error.message)
            : error.message;
        throw new SysadminError(`Hetzner API error: ${message}`, error.response?.status, body);
      }
      throw error;
    }
  }

  private async paginate<T>(resourceKey: string, path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;

    while (true) {
      const data = await this.request<HetznerListResponse<T>>(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`,
      );
      const items = toArray<T>(data[resourceKey] ?? data);
      results.push(...items);

      const nextPage = data.meta?.pagination?.next_page;
      if (!nextPage) break;
      page = nextPage;
    }

    return results;
  }

  async listNodes(): Promise<NodeSummary[]> {
    const locations = await this.paginate<JsonRecord>("locations", "/locations");
    const servers = await this.paginate<JsonRecord>("servers", "/servers");

    return locations.map((location) => {
      const locationName = firstString(location, ["name"]);
      const inLocation = servers.filter((server) => {
        const dc = server.datacenter as JsonRecord | undefined;
        const loc = dc?.location as JsonRecord | undefined;
        return firstString(loc ?? {}, ["name"]) === locationName;
      });
      const running = inLocation.filter(
        (s) => firstString(s, ["status"]).toLowerCase() === "running",
      );

      return {
        hostId: this.host.id,
        hostName: this.host.name,
        provider: "hetzner" as const,
        nodeId: locationName,
        name: `${locationName} (${firstString(location, ["city"])}, ${firstString(location, ["country"])})`,
        status: "online",
        memoryUsedMb: undefined,
        memoryTotalMb: undefined,
        cpuUsage: inLocation.length > 0 ? running.length / inLocation.length : undefined,
        uptime: inLocation.length,
      };
    });
  }

  async listVms(location?: string): Promise<VmSummary[]> {
    let servers = await this.paginate<JsonRecord>("servers", "/servers");

    if (location ?? this.host.defaultLocation) {
      const filter = location ?? this.host.defaultLocation!;
      servers = servers.filter((server) => {
        const dc = server.datacenter as JsonRecord | undefined;
        const loc = dc?.location as JsonRecord | undefined;
        return firstString(loc ?? {}, ["name"]) === filter;
      });
    }

    return servers.map((server) => this.mapServer(server));
  }

  async getVm(vmId: string): Promise<VmSummary & { raw: JsonRecord }> {
    const data = await this.request<{ server: JsonRecord }>("GET", `/servers/${vmId}`);
    const server = data.server;
    if (!server) {
      throw new SysadminError(`Hetzner server not found: ${vmId}`);
    }
    return { ...this.mapServer(server), raw: sanitizeHetznerServer(server) };
  }

  async vmPower(vmId: string, action: VmPowerAction) {
    const actionMap: Partial<Record<VmPowerAction, string>> = {
      start: "poweron",
      stop: "poweroff",
      shutdown: "shutdown",
      reboot: "reboot",
      reset: "reset",
    };

    const hetznerAction = actionMap[action];
    if (!hetznerAction) {
      throw new SysadminError(`Unsupported Hetzner action: ${action}`);
    }

    const data = await this.request<{ action: JsonRecord }>(
      "POST",
      `/servers/${vmId}/actions/${hetznerAction}`,
    );

    return {
      hostId: this.host.id,
      vmId,
      action,
      success: true,
      hetznerAction,
      actionId: firstNumber(data.action ?? {}, ["id"]),
      status: firstString(data.action ?? {}, ["status"], "running"),
    };
  }

  async getNodeStatus(nodeId: string): Promise<NodeSummary & { serversTotal: number; serversRunning: number }> {
    const nodes = await this.listNodes();
    const node = nodes.find((item) => item.nodeId === nodeId);
    if (!node) {
      throw new SysadminError(`Hetzner location not found: ${nodeId}`);
    }

    const vms = await this.listVms(nodeId);
    const running = vms.filter((vm) => vm.status === "running");

    return {
      ...node,
      serversTotal: vms.length,
      serversRunning: running.length,
    };
  }

  async listFirewalls() {
    const firewalls = await this.paginate<JsonRecord>("firewalls", "/firewalls");
    return firewalls.map((fw) => ({
      id: firstNumber(fw, ["id"]),
      name: firstString(fw, ["name"]),
      appliedToCount: toArray(fw.applied_to).length,
      rulesCount: toArray(fw.rules).length,
      labels: fw.labels ?? {},
    }));
  }

  async listVolumes() {
    const volumes = await this.paginate<JsonRecord>("volumes", "/volumes");
    return volumes.map((vol) => ({
      id: firstNumber(vol, ["id"]),
      name: firstString(vol, ["name"]),
      sizeGb: firstNumber(vol, ["size"]),
      status: firstString(vol, ["status"]),
      location: firstString((vol.location as JsonRecord) ?? {}, ["name"]),
      server: firstNumber((vol.server as JsonRecord) ?? {}, ["id"]) || undefined,
      labels: vol.labels ?? {},
    }));
  }

  async listNetwork() {
    const servers = await this.listVms();
    return servers.map((vm) => ({
      vmId: vm.vmId,
      name: vm.name,
      ip: vm.ip,
      location: vm.node,
      status: vm.status,
    }));
  }

  private mapServer(server: JsonRecord): VmSummary {
    const serverType = (server.server_type as JsonRecord) ?? {};
    const datacenter = (server.datacenter as JsonRecord) ?? {};
    const location = (datacenter.location as JsonRecord) ?? {};
    const publicNet = (server.public_net as JsonRecord) ?? {};
    const ipv4 = (publicNet.ipv4 as JsonRecord) ?? {};
    const labels = server.labels as Record<string, string> | undefined;

    return {
      hostId: this.host.id,
      hostName: this.host.name,
      provider: "hetzner",
      vmId: String(firstNumber(server, ["id"])),
      name: firstString(server, ["name"]),
      status: mapHetznerStatus(firstString(server, ["status"], "unknown")),
      type: "kvm",
      node: firstString(location, ["name"]),
      cpu: firstNumber(serverType, ["cores"]),
      memoryMb: firstNumber(serverType, ["memory"]) ? firstNumber(serverType, ["memory"])! * 1024 : undefined,
      diskGb: firstNumber(serverType, ["disk"]),
      ip: firstString(ipv4, ["ip"]) || undefined,
      tags: labels ? Object.entries(labels).map(([k, v]) => `${k}=${v}`) : [],
    };
  }
}

function mapHetznerStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "running") return "running";
  if (normalized === "off") return "stopped";
  if (["starting", "stopping", "initializing", "migrating", "rebuilding"].includes(normalized)) {
    return normalized;
  }
  return status;
}

function sanitizeHetznerServer(server: JsonRecord): JsonRecord {
  const copy = { ...server };
  delete copy.root_password;
  return copy;
}
