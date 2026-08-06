import axios, { AxiosInstance } from "axios";
import {
  firstNumber,
  firstString,
  JsonRecord,
  normalizeBaseUrl,
  SysadminError,
} from "../../api/utils.js";
import { getHttpTimeout } from "../../config/loader.js";
import { NodeSummary, VirtualizorHost, VmPowerAction, VmSummary } from "../../config/schema.js";
import { sanitizeVirtualizorPayload } from "../../security/sanitize.js";

type VirtualizorResponse = JsonRecord & {
  vs?: Record<string, JsonRecord>;
  servers?: Record<string, JsonRecord> | JsonRecord[];
  error?: string[] | JsonRecord;
};

export class VirtualizorClient {
  private readonly http: AxiosInstance;
  private readonly host: VirtualizorHost;
  private readonly baseUrl: string;

  constructor(host: VirtualizorHost) {
    this.host = host;
    this.baseUrl = `${normalizeBaseUrl(host.url)}/index.php`;
    this.http = axios.create({
      timeout: getHttpTimeout(),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
  }

  private buildBody(
    act: string,
    extra: Record<string, string | number> = {},
    post?: JsonRecord,
  ): URLSearchParams {
    const body = new URLSearchParams({
      api: "json",
      act,
      adminapikey: this.host.apiKey,
      adminapipass: this.host.apiPass,
    });

    for (const [key, value] of Object.entries(extra)) {
      body.set(key, String(value));
    }

    if (post) {
      for (const [key, value] of Object.entries(post)) {
        if (value !== undefined && value !== null) {
          body.set(key, String(value));
        }
      }
    }

    return body;
  }

  private async call(
    act: string,
    extra: Record<string, string | number> = {},
    post?: JsonRecord,
  ): Promise<VirtualizorResponse> {
    try {
      const response = await this.http.post(this.baseUrl, this.buildBody(act, extra, post));
      const data = response.data as VirtualizorResponse;

      if (data.error) {
        const message = Array.isArray(data.error) ? data.error.join(", ") : JSON.stringify(data.error);
        throw new SysadminError(`Virtualizor API error (${act}): ${message}`);
      }
      return data;
    } catch (error) {
      if (error instanceof SysadminError) throw error;
      if (axios.isAxiosError(error)) {
        throw new SysadminError(
          `Virtualizor request failed (${act}): ${error.message}`,
          error.response?.status,
        );
      }
      throw error;
    }
  }

  async listNodes(): Promise<NodeSummary[]> {
    const data = await this.call("servers");
    const servers = normalizeRecordMap(data.servers);

    return servers.map((server) => ({
      hostId: this.host.id,
      hostName: this.host.name,
      provider: "virtualizor" as const,
      nodeId: firstString(server, ["serid", "id"]),
      name: firstString(server, ["name", "server_name"], firstString(server, ["serid", "id"])),
      status: firstString(server, ["status"], "unknown"),
      cpuUsage: firstNumber(server, ["cpu"]),
      memoryUsedMb: firstNumber(server, ["ram_used", "used_ram"]),
      memoryTotalMb: firstNumber(server, ["ram", "total_ram"]),
    }));
  }

  async listVms(page = 1, reslen = 100): Promise<VmSummary[]> {
    const data = await this.call("vs", { page, reslen });
    const vms = normalizeRecordMap(data.vs);
    return vms.map((vm) => this.mapVm(vm));
  }

  async getVm(vmId: string): Promise<VmSummary & { raw: JsonRecord }> {
    const data = await this.call("vs", { vpsid: vmId, page: 1, reslen: 1 });
    const vms = normalizeRecordMap(data.vs);
    const vm = vms.find((item) => firstString(item, ["vpsid", "vps_id"]) === vmId) ?? vms[0];

    if (!vm) {
      throw new SysadminError(`Virtualizor VPS not found: ${vmId}`);
    }

    return { ...this.mapVm(vm), raw: sanitizeVirtualizorPayload(vm) };
  }

  async vmPower(vmId: string, action: VmPowerAction) {
    const actMap: Partial<Record<VmPowerAction, string>> = {
      start: "start",
      stop: "stop",
      reboot: "restart",
      shutdown: "stop",
      reset: "restart",
    };

    const act = actMap[action];
    if (!act) {
      throw new SysadminError(`Unsupported Virtualizor action: ${action}`);
    }

    const data = await this.call(act, {}, { vpsid: vmId });
    return {
      hostId: this.host.id,
      vmId,
      action,
      success: true,
      message: firstString(data as JsonRecord, ["done", "msg"], "ok"),
    };
  }

  async getNodeStatus(nodeId: string) {
    const nodes = await this.listNodes();
    const node = nodes.find((item) => item.nodeId === nodeId);
    if (!node) {
      throw new SysadminError(`Virtualizor server/node not found: ${nodeId}`);
    }
    return node;
  }

  private mapVm(vm: JsonRecord): VmSummary {
    const virt = firstString(vm, ["virt", "type"]).toLowerCase();
    const vmType =
      virt.includes("kvm") ? "kvm"
      : virt.includes("xen") ? "qemu"
      : virt.includes("openvz") || virt.includes("vz") ? "openvz"
      : "unknown";

    return {
      hostId: this.host.id,
      hostName: this.host.name,
      provider: "virtualizor",
      vmId: firstString(vm, ["vpsid", "vps_id"]),
      name: firstString(vm, ["vps_name", "hostname", "vpsid"], firstString(vm, ["vpsid"])),
      status: mapVirtualizorStatus(firstString(vm, ["status", "state"], "unknown")),
      type: vmType,
      node: firstString(vm, ["serid", "server"]),
      cpu: firstNumber(vm, ["cores", "cpu"]),
      memoryMb: firstNumber(vm, ["ram", "memory"]),
      diskGb: firstNumber(vm, ["space", "disk"]),
      ip: firstString(vm, ["ips", "ip"]),
      tags: [],
    };
  }
}

function normalizeRecordMap(value: unknown): JsonRecord[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as JsonRecord[];
  if (typeof value === "object") {
    return Object.values(value as Record<string, JsonRecord>);
  }
  return [];
}

function mapVirtualizorStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "1" || normalized === "on") return "running";
  if (normalized === "0" || normalized === "off") return "stopped";
  return status;
}
