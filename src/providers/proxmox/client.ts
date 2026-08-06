import axios, { AxiosInstance } from "axios";
import https from "node:https";
import {
  firstNumber,
  firstString,
  JsonRecord,
  normalizeBaseUrl,
  SysadminError,
  toArray,
  unwrapData,
} from "../../api/utils.js";
import { getHttpTimeout } from "../../config/loader.js";
import { NodeSummary, ProxmoxHost, VmPowerAction, VmSummary, VmType } from "../../config/schema.js";

export class ProxmoxClient {
  private readonly http: AxiosInstance;
  private readonly host: ProxmoxHost;

  constructor(host: ProxmoxHost) {
    this.host = host;
    this.http = axios.create({
      baseURL: `${normalizeBaseUrl(host.url)}/api2/json`,
      timeout: getHttpTimeout(),
      headers: {
        Authorization: `PVEAPIToken=${host.tokenId}=${host.tokenSecret}`,
        Accept: "application/json",
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: host.verifySsl }),
    });
  }

  private async request<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, data?: unknown): Promise<T> {
    try {
      const response = await this.http.request({ method, url: path, data });
      return unwrapData<T>(response.data);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const body = error.response?.data;
        const message =
          typeof body === "object" && body && "errors" in body
            ? JSON.stringify((body as JsonRecord).errors)
            : error.message;
        throw new SysadminError(`Proxmox API error: ${message}`, status, body);
      }
      throw error;
    }
  }

  async listNodes(): Promise<NodeSummary[]> {
    const nodes = toArray<JsonRecord>(await this.request("GET", "/nodes"));
    return nodes.map((node) => ({
      hostId: this.host.id,
      hostName: this.host.name,
      provider: "proxmox" as const,
      nodeId: firstString(node, ["node"]),
      name: firstString(node, ["node"]),
      status: firstString(node, ["status"], "unknown"),
      cpuUsage: firstNumber(node, ["cpu"]),
      memoryUsedMb: firstNumber(node, ["mem"]) ? Math.round(firstNumber(node, ["mem"])! / 1_048_576) : undefined,
      memoryTotalMb: firstNumber(node, ["maxmem"]) ? Math.round(firstNumber(node, ["maxmem"])! / 1_048_576) : undefined,
      uptime: firstNumber(node, ["uptime"]),
    }));
  }

  async getNodeStatus(node: string) {
    const status = await this.request<JsonRecord>("GET", `/nodes/${encodeURIComponent(node)}/status`);
    const record = (status ?? {}) as JsonRecord;
    return {
      hostId: this.host.id,
      node,
      status: firstString(record, ["status"], "unknown"),
      cpuUsage: firstNumber(record, ["cpu"]),
      memoryUsedMb: firstNumber(record, ["memory", "used"]) ?? firstNumber(record, ["mem"]),
      memoryTotalMb: firstNumber(record, ["memory", "total"]) ?? firstNumber(record, ["maxmem"]),
      uptime: firstNumber(record, ["uptime"]),
      raw: record,
    };
  }

  async listVms(node?: string): Promise<VmSummary[]> {
    const nodes = node ? [node] : (await this.listNodes()).map((item) => item.nodeId);
    const results: VmSummary[] = [];

    for (const nodeName of nodes) {
      const [qemu, lxc] = await Promise.all([
        this.request<JsonRecord[]>("GET", `/nodes/${encodeURIComponent(nodeName)}/qemu`).catch(() => []),
        this.request<JsonRecord[]>("GET", `/nodes/${encodeURIComponent(nodeName)}/lxc`).catch(() => []),
      ]);

      for (const vm of toArray<JsonRecord>(qemu)) {
        results.push(this.mapVm(nodeName, vm, "qemu"));
      }
      for (const vm of toArray<JsonRecord>(lxc)) {
        results.push(this.mapVm(nodeName, vm, "lxc"));
      }
    }

    return results;
  }

  async getVm(node: string, vmId: string, vmType: VmType = "qemu") {
    const type = vmType === "lxc" ? "lxc" : "qemu";
    const [status, config] = await Promise.all([
      this.request<JsonRecord>("GET", `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmId)}/status/current`),
      this.request<JsonRecord>("GET", `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmId)}/config`).catch(() => ({})),
    ]);

    return {
      ...this.mapVm(node, { ...config, ...status, vmid: vmId }, type),
      config,
      statusRaw: status,
    };
  }

  async vmPower(node: string, vmId: string, action: VmPowerAction, vmType: VmType = "qemu") {
    const type = vmType === "lxc" ? "lxc" : "qemu";
    const allowed = new Set(["start", "stop", "shutdown", "reboot", "reset", "suspend", "resume"]);
    if (!allowed.has(action)) {
      throw new SysadminError(`Unsupported Proxmox action: ${action}`);
    }

    const upid = await this.request<string>(
      "POST",
      `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmId)}/status/${action}`,
    );

    return {
      hostId: this.host.id,
      node,
      vmId,
      vmType: type,
      action,
      taskId: upid,
    };
  }

  async createSnapshot(node: string, vmId: string, snapname: string, description?: string, vmType: VmType = "qemu") {
    const type = vmType === "lxc" ? "lxc" : "qemu";
    const upid = await this.request<string>(
      "POST",
      `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmId)}/snapshot`,
      { snapname, description },
    );

    return { hostId: this.host.id, node, vmId, vmType: type, snapname, taskId: upid };
  }

  async listSnapshots(node: string, vmId: string, vmType: VmType = "qemu") {
    const type = vmType === "lxc" ? "lxc" : "qemu";
    const snapshots = await this.request<JsonRecord[]>(
      "GET",
      `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmId)}/snapshot`,
    );
    return toArray<JsonRecord>(snapshots).map((snap) => ({
      name: firstString(snap, ["name", "snapname"]),
      description: firstString(snap, ["description"]),
      snaptime: firstNumber(snap, ["snaptime"]),
      vmstate: snap.vmstate,
    }));
  }

  async listTasks(node?: string, limit = 50) {
    const path = node
      ? `/nodes/${encodeURIComponent(node)}/tasks?limit=${limit}`
      : `/cluster/tasks?limit=${limit}`;
    const tasks = await this.request<JsonRecord[]>("GET", path);
    return toArray<JsonRecord>(tasks).map((task) => ({
      upid: firstString(task, ["upid"]),
      type: firstString(task, ["type"]),
      status: firstString(task, ["status"]),
      node: firstString(task, ["node"]),
      user: firstString(task, ["user"]),
      starttime: firstNumber(task, ["starttime"]),
      endtime: firstNumber(task, ["endtime"]),
    }));
  }

  resolveNode(explicitNode?: string): string {
    const node = explicitNode ?? this.host.defaultNode;
    if (!node) {
      throw new SysadminError(
        `Node is required for Proxmox host ${this.host.id}. Provide 'node' or set defaultNode in inventory.`,
      );
    }
    return node;
  }

  private mapVm(node: string, vm: JsonRecord, type: VmType): VmSummary {
    const memoryBytes = firstNumber(vm, ["maxmem", "mem"]);
    const diskBytes = firstNumber(vm, ["maxdisk", "disk"]);
    return {
      hostId: this.host.id,
      hostName: this.host.name,
      provider: "proxmox",
      vmId: firstString(vm, ["vmid", "id"]),
      name: firstString(vm, ["name", "hostname"], firstString(vm, ["vmid", "id"])),
      status: firstString(vm, ["status", "qmpstatus"], "unknown"),
      type,
      node,
      cpu: firstNumber(vm, ["cpus", "cores"]),
      memoryMb: memoryBytes ? Math.round(memoryBytes / 1_048_576) : undefined,
      diskGb: diskBytes ? Math.round(diskBytes / 1_073_741_824) : undefined,
      tags: typeof vm.tags === "string" ? vm.tags.split(";").filter(Boolean) : undefined,
    };
  }
}