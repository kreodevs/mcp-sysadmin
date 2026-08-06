import { optionalEnv, SysadminError } from "../api/utils.js";
import { Host, Inventory } from "../config/schema.js";

export type ToolCategory = "read" | "write" | "destructive";

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  "list-hosts": "read",
  "get-host": "read",
  "list-nodes": "read",
  "get-node-status": "read",
  "list-vms": "read",
  "get-vm": "read",
  "list-vm-snapshots": "read",
  "list-proxmox-tasks": "read",
  "vm-power": "destructive",
  "create-vm-snapshot": "destructive",
  "ssh-exec": "destructive",
  "ssh-read-file": "write",
};

const DESTRUCTIVE_VM_ACTIONS = new Set(["stop", "shutdown", "reboot", "reset"]);

const SSH_BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r/i,
  /\brm\s+-[^\s]*r/i,
  /\brm\s+(-[^\s]+\s+)*\/\s*$/,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shred|wipefs)\b/i,
  /\b(curl|wget)\s+[^\s|]+\s*\|\s*(ba)?sh\b/i,
  /\|\s*(ba)?sh\s*$/i,
  /\bchmod\s+(-[^\s]+\s+)*777\s+\//,
  /\buserdel\b/i,
  /\bgroupdel\b/i,
  /\bpasswd\s+root\b/i,
  /\bsystemctl\s+(disable|mask)\s+sshd\b/i,
  /\biptables\s+-F\b/i,
  /\bufw\s+disable\b/i,
  /\bnc\s+-[^\s]*e\s+\/bin\/(ba)?sh\b/i,
  /\bpython\s+-c\s+.*socket/i,
];

const SSH_BLOCKED_FILE_PATTERNS: RegExp[] = [
  /^\/etc\/shadow$/i,
  /^\/etc\/gshadow$/i,
  /^\/etc\/sudoers/i,
];

const SSH_SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\/root\/\.ssh\//i,
  /^\/home\/[^/]+\/\.ssh\/id_/i,
  /^\/home\/[^/]+\/\.ssh\/authorized_keys$/i,
  /\.pem$/i,
  /\.key$/i,
  /^\/root\/\.(env|aws|config)/i,
  /^\/etc\/ssl\/private\//i,
  /^\/var\/lib\/docker\/secrets\//i,
];

export function isGlobalReadOnly(): boolean {
  return optionalEnv("SYSADMIN_READ_ONLY", "false") === "true";
}

export function isConfirmRequired(inventoryDefaults?: Inventory["defaults"]): boolean {
  if (optionalEnv("SYSADMIN_REQUIRE_CONFIRM") === "false") return false;
  if (inventoryDefaults?.requireConfirm === false) return false;
  return true;
}

export function assertToolAllowed(
  toolName: string,
  host: Host | undefined,
  inventoryDefaults?: Inventory["defaults"],
): void {
  if (isGlobalReadOnly() && TOOL_CATEGORIES[toolName] !== "read") {
    throw new SysadminError(
      `Tool '${toolName}' blocked: SYSADMIN_READ_ONLY=true (solo operaciones de lectura).`,
    );
  }

  if (host?.readOnly && TOOL_CATEGORIES[toolName] !== "read") {
    throw new SysadminError(`Tool '${toolName}' blocked: host '${host.id}' is readOnly.`);
  }

  if (host?.allowedTools && host.allowedTools.length > 0 && !host.allowedTools.includes(toolName)) {
    throw new SysadminError(
      `Tool '${toolName}' not in allowedTools for host '${host.id}': [${host.allowedTools.join(", ")}]`,
    );
  }

  if (inventoryDefaults?.readOnly && TOOL_CATEGORIES[toolName] !== "read" && !host) {
    throw new SysadminError(`Tool '${toolName}' blocked: inventory defaults.readOnly=true.`);
  }
}

export function assertConfirmed(
  confirm: boolean | undefined,
  toolName: string,
  summary: string,
  inventoryDefaults?: Inventory["defaults"],
): void {
  if (!isConfirmRequired(inventoryDefaults)) return;

  const category = TOOL_CATEGORIES[toolName];
  const needsConfirm = category === "destructive" || category === "write";

  if (needsConfirm && confirm !== true) {
    throw new SysadminError(
      `Confirmación requerida para '${toolName}'. Reintenta con confirm=true. Operación: ${summary}`,
    );
  }
}

export function assertVmPowerAllowed(action: string): void {
  if (DESTRUCTIVE_VM_ACTIONS.has(action) && isGlobalReadOnly()) {
    throw new SysadminError(`vm-power action '${action}' blocked in read-only mode.`);
  }
}

export function assertSshCommandAllowed(command: string): void {
  const normalized = command.trim();
  if (!normalized) {
    throw new SysadminError("SSH command cannot be empty.");
  }

  for (const pattern of SSH_BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new SysadminError(`SSH command blocked by security policy (matched: ${pattern.source}).`);
    }
  }
}

export function assertSshPathAllowed(filePath: string, confirm?: boolean): void {
  const normalized = filePath.trim();

  for (const pattern of SSH_BLOCKED_FILE_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new SysadminError(`Reading '${normalized}' blocked: path is never allowed.`);
    }
  }

  for (const pattern of SSH_SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalized) && confirm !== true) {
      throw new SysadminError(
        `Path '${normalized}' is sensitive. Reintenta ssh-read-file con confirm=true.`,
      );
    }
  }
}
