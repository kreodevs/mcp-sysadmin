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
        "Ejecuta un comando en un servidor SSH del inventario. Requiere confirm=true y confirmToken " +
        "(SYSADMIN_CONFIRM_TOKEN). En producción solo comandos en allowlist.",
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
          input.confirmToken,
          "ssh-exec",
          `command on ${input.hostId}`,
          context.defaults,
        );
        assertSshCommandAllowed(input.command, host, context.defaults);

        const result = await context.registry.ssh().exec(
          host,
          input.command,
          input.cwd,
          input.timeoutMs,
        );

        return jsonContent({
          hostId: input.hostId,
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
        "Lee un archivo remoto vía SSH. Resuelve symlinks con readlink -f. " +
        "Requiere confirm=true y confirmToken. Paths sensibles bloqueados o requieren confirmación.",
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
          input.confirmToken,
          "ssh-read-file",
          `read on ${input.hostId}`,
          context.defaults,
        );

        const ssh = context.registry.ssh();
        const resolved = await ssh.resolveRemotePath(host, input.path);
        assertSshPathAllowed(resolved, input.confirm);

        const content = await ssh.readResolvedFile(host, resolved, input.maxBytes);

        return jsonContent({
          hostId: input.hostId,
          path: resolved,
          bytes: content.length,
          content,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

