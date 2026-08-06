import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonContent, toolError } from "../api/utils.js";
import { SshExecSchema, SshReadFileSchema } from "../config/schema.js";
import { guardToolAccess } from "../security/guard.js";
import {
  assertConfirmed,
  assertSshCommandAllowed,
  assertSshPathAllowed,
} from "../security/policy.js";
import { ToolContext } from "./context.js";

export function registerSshTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "ssh-exec",
    {
      title: "SSH Execute Command",
      description:
        "Ejecuta un comando en un servidor físico o VPS accesible por SSH del inventario. " +
        "Requiere confirm=true. Comandos destructivos conocidos están bloqueados por policy.",
      inputSchema: SshExecSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({
          toolName: "ssh-exec",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        assertConfirmed(
          input.confirm,
          "ssh-exec",
          `command on ${input.hostId}: ${input.command.slice(0, 120)}`,
          context.defaults,
        );
        assertSshCommandAllowed(input.command);

        const result = await context.registry.ssh().exec(
          host,
          input.command,
          input.cwd,
          input.timeoutMs,
        );

        return jsonContent({
          hostId: input.hostId,
          command: input.command,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "ssh-read-file",
    {
      title: "SSH Read File",
      description:
        "Lee un archivo remoto vía SSH (limitado por maxBytes, default 256KB). " +
        "Requiere confirm=true. Paths sensibles requieren confirm=true explícito.",
      inputSchema: SshReadFileSchema,
    },
    async (input) => {
      try {
        const host = context.registry.getSsh(input.hostId);
        guardToolAccess({
          toolName: "ssh-read-file",
          hostId: input.hostId,
          host,
          defaults: context.defaults,
        });

        assertConfirmed(
          input.confirm,
          "ssh-read-file",
          `read ${input.path} on ${input.hostId}`,
          context.defaults,
        );
        assertSshPathAllowed(input.path, input.confirm);

        const content = await context.registry.ssh().readFile(
          host,
          input.path,
          input.maxBytes,
        );

        return jsonContent({
          hostId: input.hostId,
          path: input.path,
          bytes: content.length,
          content,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
