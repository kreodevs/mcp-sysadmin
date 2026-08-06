import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, toolError } from "../api/utils.js";
import { HostIdSchema } from "../config/schema.js";
import { guardToolAccess } from "../security/guard.js";
import { ToolContext } from "./context.js";

const SshHostSchema = HostIdSchema;

export function registerDiagnosticsTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "ssh-tail-log",
    {
      title: "SSH Tail Log",
      description: "Read-only: últimas líneas de journalctl -u UNIT o tail de archivo en /var/log/.",
      inputSchema: SshHostSchema.extend({
        unit: z.string().optional(),
        path: z.string().optional(),
        lines: z.number().int().positive().max(500).optional(),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "ssh-tail-log", hostId: input.hostId, host, defaults: context.defaults });
        const result = await context.registry.sshDiag().tailLog(host, input.lines ?? 100, input.unit, input.path);
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-firewall-rules",
    {
      title: "List Firewall Rules",
      description: "Read-only: reglas UFW, nftables o iptables en servidor SSH.",
      inputSchema: SshHostSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "list-firewall-rules", hostId: input.hostId, host, defaults: context.defaults });
        return jsonContent({ hostId: input.hostId, ...(await context.registry.sshDiag().listFirewallRules(host)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-systemd-units",
    {
      title: "List Systemd Units",
      description: "Read-only: unidades systemd failed, running o all.",
      inputSchema: SshHostSchema.extend({
        state: z.enum(["failed", "running", "all"]).optional(),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "list-systemd-units", hostId: input.hostId, host, defaults: context.defaults });
        const result = await context.registry.sshDiag().listSystemdUnits(host, input.state ?? "failed");
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "cert-status",
    {
      title: "Cert Status",
      description: "Read-only: certificados Let's Encrypt (certbot) y fechas SSL de un dominio.",
      inputSchema: SshHostSchema.extend({ domain: z.string().optional() }),
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "cert-status", hostId: input.hostId, host, defaults: context.defaults });
        const result = await context.registry.sshDiag().certStatus(host, input.domain);
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "dns-lookup",
    {
      title: "DNS Lookup",
      description: "Read-only: resolución DNS desde el servidor SSH (getent/nslookup).",
      inputSchema: SshHostSchema.extend({ hostname: z.string().min(1) }),
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "dns-lookup", hostId: input.hostId, host, defaults: context.defaults });
        const result = await context.registry.sshDiag().dnsLookup(host, input.hostname);
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "check-endpoint",
    {
      title: "Check Endpoint",
      description: "Read-only: prueba HTTP/HTTPS o puerto TCP hacia un target desde el servidor SSH.",
      inputSchema: SshHostSchema.extend({
        target: z.string().min(1),
        port: z.number().int().positive().max(65535).optional(),
        useHttps: z.boolean().optional(),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "check-endpoint", hostId: input.hostId, host, defaults: context.defaults });
        const result = await context.registry.sshDiag().checkEndpoint(
          host,
          input.target,
          input.port ?? 443,
          input.useHttps ?? true,
        );
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-cron",
    {
      title: "List Cron",
      description: "Read-only: crontab del usuario y jobs en /etc/cron.d.",
      inputSchema: SshHostSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "list-cron", hostId: input.hostId, host, defaults: context.defaults });
        const result = await context.registry.sshDiag().listCron(host);
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-timers",
    {
      title: "List Timers",
      description: "Read-only: systemd timers activos.",
      inputSchema: SshHostSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "list-timers", hostId: input.hostId, host, defaults: context.defaults });
        const result = await context.registry.sshDiag().listTimers(host);
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "docker-compose-ps",
    {
      title: "Docker Compose PS",
      description: "Read-only: estado de contenedores docker compose (opcional projectDir).",
      inputSchema: SshHostSchema.extend({
        projectDir: z.string().optional().describe("Ruta absoluta del proyecto compose"),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({ toolName: "docker-compose-ps", hostId: input.hostId, host, defaults: context.defaults });
        const result = await context.registry.sshDiag().dockerComposePs(host, input.projectDir);
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
