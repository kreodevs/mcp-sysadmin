import { Host, SshHost } from "../config/schema.js";
import { ProviderRegistry } from "./registry.js";

export type HealthResult = {
  hostId: string;
  hostName: string;
  provider: Host["provider"];
  status: "healthy" | "degraded" | "unreachable" | "unknown";
  checks: Record<string, unknown>;
  error?: string;
};

export async function runHealthCheck(registry: ProviderRegistry, hostId?: string): Promise<HealthResult[]> {
  const hosts = hostId ? [registry.getHost(hostId)] : registry.listHosts();
  const results: HealthResult[] = [];

  for (const host of hosts) {
    try {
      results.push(await checkHost(registry, host));
    } catch (error) {
      results.push({
        hostId: host.id,
        hostName: host.name,
        provider: host.provider,
        status: "unreachable",
        checks: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function checkHost(registry: ProviderRegistry, host: Host): Promise<HealthResult> {
  if (host.provider === "ssh") {
    const sshHost = host as SshHost;
    const stats = await registry.ssh().getHostStats(sshHost);
    const diskUse = parseInt(String(stats.disk?.usePercent ?? "0").replace("%", ""), 10) || 0;
    const memUsed = stats.memory?.usedMb ?? 0;
    const memTotal = stats.memory?.totalMb ?? 1;
    const memPct = Math.round((memUsed / memTotal) * 100);
    const status = diskUse > 90 || memPct > 90 ? "degraded" : "healthy";
    return {
      hostId: host.id,
      hostName: host.name,
      provider: "ssh",
      status,
      checks: { ...stats, diskUsePercent: diskUse, memoryUsePercent: memPct },
    };
  }

  if (host.provider === "proxmox") {
    const client = registry.getProxmox(host.id);
    const nodes = await client.listNodes();
    const offline = nodes.filter((n) => n.status !== "online");
    const vms = await client.listVms();
    const stopped = vms.filter((v) => !["running", "on"].includes(v.status.toLowerCase()));
    return {
      hostId: host.id,
      hostName: host.name,
      provider: "proxmox",
      status: offline.length > 0 ? "degraded" : "healthy",
      checks: {
        nodesOnline: nodes.length - offline.length,
        nodesTotal: nodes.length,
        vmsRunning: vms.length - stopped.length,
        vmsTotal: vms.length,
        offlineNodes: offline.map((n) => n.nodeId),
      },
    };
  }

  if (host.provider === "virtualizor") {
    const client = registry.getVirtualizor(host.id);
    const vms = await client.listVms();
    const stopped = vms.filter((v) => v.status === "stopped");
    return {
      hostId: host.id,
      hostName: host.name,
      provider: "virtualizor",
      status: "healthy",
      checks: {
        vpsTotal: vms.length,
        vpsRunning: vms.length - stopped.length,
        vpsStopped: stopped.length,
      },
    };
  }

  throw new Error(`Unsupported provider for health check: ${(host as Host).provider}`);
}

export async function listNetworkInfo(registry: ProviderRegistry, hostId: string, node?: string) {
  const host = registry.getHost(hostId);

  if (host.provider === "proxmox") {
    const client = registry.getProxmox(hostId);
    const nodeName = client.resolveNode(node);
    return { hostId, provider: "proxmox", node: nodeName, interfaces: await client.listNetwork(nodeName) };
  }

  if (host.provider === "virtualizor") {
    const vms = await registry.getVirtualizor(hostId).listVms();
    return {
      hostId,
      provider: "virtualizor",
      ips: vms.map((vm) => ({ vmId: vm.vmId, name: vm.name, ip: vm.ip, node: vm.node })),
    };
  }

  if (host.provider === "ssh") {
    const sshHost = registry.getSsh(hostId);
    const result = await registry.ssh().execInternal(sshHost, "ip -br addr 2>/dev/null || ifconfig -a 2>/dev/null | head -40");
    return { hostId, provider: "ssh", output: result.stdout, exitCode: result.exitCode };
  }

  throw new Error(`list-network not supported for host ${hostId}`);
}
