import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, toolError } from "../api/utils.js";
import { ConfirmSchema, HostIdSchema } from "../config/schema.js";
import { guardToolAccess } from "../security/guard.js";
import { assertConfirmed } from "../security/policy.js";
import { ToolContext } from "./context.js";

const ZoneRefSchema = HostIdSchema.extend({
  zoneId: z.string().optional().describe("Cloudflare Zone ID (usa defaultZoneId del inventario si se omite)"),
});

const DnsRecordRefSchema = ZoneRefSchema.extend({
  recordId: z.string().min(1).describe("ID del registro DNS"),
});

const DnsRecordWriteSchema = ZoneRefSchema.merge(ConfirmSchema).extend({
  type: z.string().min(1).describe("Tipo DNS: A, AAAA, CNAME, TXT, MX, etc."),
  name: z.string().min(1).describe("Nombre del registro (ej. www o @)"),
  content: z.string().min(1).describe("Contenido del registro"),
  ttl: z.number().int().min(1).max(86400).optional().describe("TTL en segundos (1 = auto)"),
  proxied: z.boolean().optional().describe("Proxy naranja de Cloudflare"),
  priority: z.number().int().optional().describe("Prioridad para MX/SRV"),
  comment: z.string().optional(),
});

const DnsRecordUpdateSchema = DnsRecordRefSchema.merge(ConfirmSchema).extend({
  type: z.string().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
  ttl: z.number().int().min(1).max(86400).optional(),
  proxied: z.boolean().optional(),
  priority: z.number().int().optional(),
  comment: z.string().optional(),
});

export function registerCloudflareTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "list-zones",
    {
      title: "List Cloudflare Zones",
      description: "Lista zonas DNS en una cuenta Cloudflare.",
      inputSchema: HostIdSchema.extend({
        name: z.string().optional().describe("Filtrar por nombre de dominio exacto"),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "list-zones", hostId: input.hostId, host, defaults: context.defaults });

        if (host.provider !== "cloudflare") {
          return toolError(new Error(`Host ${input.hostId} is not a Cloudflare provider`));
        }

        const zones = await context.registry.getCloudflare(input.hostId).listZones(input.name);
        return jsonContent({ hostId: input.hostId, count: zones.length, zones });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-dns-records",
    {
      title: "List DNS Records",
      description: "Lista registros DNS de una zona Cloudflare.",
      inputSchema: ZoneRefSchema.extend({
        type: z.string().optional().describe("Filtrar por tipo (A, CNAME, TXT, etc.)"),
        name: z.string().optional().describe("Filtrar por nombre"),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "list-dns-records", hostId: input.hostId, host, defaults: context.defaults });

        const client = context.registry.getCloudflare(input.hostId);
        const zoneId = client.resolveZoneId(input.zoneId);
        const records = await client.listDnsRecords(zoneId, input.type, input.name);
        return jsonContent({ hostId: input.hostId, zoneId, count: records.length, records });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get-dns-record",
    {
      title: "Get DNS Record",
      description: "Obtiene un registro DNS específico de Cloudflare.",
      inputSchema: DnsRecordRefSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "get-dns-record", hostId: input.hostId, host, defaults: context.defaults });

        const client = context.registry.getCloudflare(input.hostId);
        const zoneId = client.resolveZoneId(input.zoneId);
        const record = await client.getDnsRecord(zoneId, input.recordId);
        return jsonContent({ hostId: input.hostId, zoneId, record });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create-dns-record",
    {
      title: "Create DNS Record",
      description: "Crea un registro DNS en Cloudflare. Requiere confirm=true y confirmToken.",
      inputSchema: DnsRecordWriteSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "create-dns-record", hostId: input.hostId, host, defaults: context.defaults });

        assertConfirmed(
          input.confirm,
          input.confirmToken,
          "create-dns-record",
          `${input.type} ${input.name} -> ${input.content}`,
          context.defaults,
        );

        const client = context.registry.getCloudflare(input.hostId);
        const zoneId = client.resolveZoneId(input.zoneId);
        const record = await client.createDnsRecord(zoneId, {
          type: input.type,
          name: input.name,
          content: input.content,
          ttl: input.ttl,
          proxied: input.proxied,
          priority: input.priority,
          comment: input.comment,
        });
        return jsonContent({ hostId: input.hostId, zoneId, record, created: true });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "update-dns-record",
    {
      title: "Update DNS Record",
      description: "Actualiza un registro DNS en Cloudflare. Requiere confirm=true y confirmToken.",
      inputSchema: DnsRecordUpdateSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "update-dns-record", hostId: input.hostId, host, defaults: context.defaults });

        assertConfirmed(
          input.confirm,
          input.confirmToken,
          "update-dns-record",
          `record ${input.recordId}`,
          context.defaults,
        );

        const client = context.registry.getCloudflare(input.hostId);
        const zoneId = client.resolveZoneId(input.zoneId);
        const record = await client.updateDnsRecord(zoneId, input.recordId, {
          type: input.type,
          name: input.name,
          content: input.content,
          ttl: input.ttl,
          proxied: input.proxied,
          priority: input.priority,
          comment: input.comment,
        });
        return jsonContent({ hostId: input.hostId, zoneId, record, updated: true });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "delete-dns-record",
    {
      title: "Delete DNS Record",
      description: "Elimina un registro DNS en Cloudflare. Requiere confirm=true y confirmToken.",
      inputSchema: DnsRecordRefSchema.merge(ConfirmSchema),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "delete-dns-record", hostId: input.hostId, host, defaults: context.defaults });

        assertConfirmed(
          input.confirm,
          input.confirmToken,
          "delete-dns-record",
          `record ${input.recordId}`,
          context.defaults,
        );

        const client = context.registry.getCloudflare(input.hostId);
        const zoneId = client.resolveZoneId(input.zoneId);
        const result = await client.deleteDnsRecord(zoneId, input.recordId);
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "purge-cache",
    {
      title: "Purge Cloudflare Cache",
      description: "Purga la caché CDN de una zona Cloudflare. Requiere confirm=true y confirmToken.",
      inputSchema: ZoneRefSchema.merge(ConfirmSchema).extend({
        purgeEverything: z.boolean().optional().describe("Si true (default), purga toda la caché"),
        files: z.array(z.string().url()).optional().describe("URLs específicas a purgar"),
      }),
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "purge-cache", hostId: input.hostId, host, defaults: context.defaults });

        assertConfirmed(
          input.confirm,
          input.confirmToken,
          "purge-cache",
          `zone ${input.zoneId ?? "default"}`,
          context.defaults,
        );

        const client = context.registry.getCloudflare(input.hostId);
        const zoneId = client.resolveZoneId(input.zoneId);
        const result = await client.purgeCache(
          zoneId,
          input.purgeEverything ?? true,
          input.files,
        );
        return jsonContent({ hostId: input.hostId, ...result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-waf-rules",
    {
      title: "List WAF Rulesets",
      description: "Lista rulesets WAF/firewall de una zona Cloudflare.",
      inputSchema: ZoneRefSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({ toolName: "list-waf-rules", hostId: input.hostId, host, defaults: context.defaults });

        const client = context.registry.getCloudflare(input.hostId);
        const zoneId = client.resolveZoneId(input.zoneId);
        const rulesets = await client.listWafRules(zoneId);
        return jsonContent({ hostId: input.hostId, zoneId, count: rulesets.length, rulesets });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
