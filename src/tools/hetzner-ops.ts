import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonContent, toolError } from "../api/utils.js";
import { HostIdSchema } from "../config/schema.js";
import { guardToolAccess } from "../security/guard.js";
import { ToolContext } from "./context.js";

export function registerHetznerOpsTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "list-hetzner-firewalls",
    {
      title: "List Hetzner Firewalls",
      description: "Lista firewalls configurados en Hetzner Cloud.",
      inputSchema: HostIdSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({
          toolName: "list-hetzner-firewalls",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        if (host.provider !== "hetzner") {
          return toolError(new Error(`Host ${input.hostId} is not a Hetzner provider`));
        }

        const firewalls = await context.registry.getHetzner(input.hostId).listFirewalls();
        return jsonContent({ hostId: input.hostId, count: firewalls.length, firewalls });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list-hetzner-volumes",
    {
      title: "List Hetzner Volumes",
      description: "Lista volúmenes de almacenamiento en Hetzner Cloud.",
      inputSchema: HostIdSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getHost(input.hostId);
        guardToolAccess({
          toolName: "list-hetzner-volumes",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        if (host.provider !== "hetzner") {
          return toolError(new Error(`Host ${input.hostId} is not a Hetzner provider`));
        }

        const volumes = await context.registry.getHetzner(input.hostId).listVolumes();
        return jsonContent({ hostId: input.hostId, count: volumes.length, volumes });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
