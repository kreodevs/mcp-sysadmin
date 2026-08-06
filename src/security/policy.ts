import { createHash } from "node:crypto";
import { optionalEnv, SysadminError } from "../api/utils.js";
import { Host, Inventory, SshHost } from "../config/schema.js";
import { isProductionMode, compileValidatedCommandPattern } from "./startup.js";
import { assertConfirmToken } from "./approve.js";

export type ToolCategory = "read" | "write" | "destructive";

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  "list-hosts": "read",
  "get-host": "read",
  "list-nodes": "read",
  "get-node-status": "read",
  "list-vms": "read",
  "list-containers": "read",
  "get-vm": "read",
  "list-vm-snapshots": "read",
  "list-proxmox-tasks": "read",
  "get-proxmox-task": "read",
  "list-storage-usage": "read",
  "list-backups": "read",
  "list-network": "read",
  "health-check": "read",
  "ssh-tail-log": "read",
  "list-firewall-rules": "read",
  "list-systemd-units": "read",
  "cert-status": "read",
  "dns-lookup": "read",
  "check-endpoint": "read",
  "list-cron": "read",
  "list-timers": "read",
  "docker-compose-ps": "read",
  "vm-power": "destructive",
  "create-vm-snapshot": "destructive",
  "create-backup": "destructive",
  "ssh-exec": "destructive",
  "ssh-read-file": "write",
};

/** Safe command prefixes for production allowlist (extended per-host via inventory). */
export const DEFAULT_SSH_ALLOWLIST: RegExp[] = [
  /^systemctl\s+(status|is-active|is-enabled|is-failed|list-units|show)\b/i,
  /^journalctl\b/i,
  /^docker\s+(ps|logs|inspect|stats|info|version|compose\s+ps)\b/i,
  /^kubectl\s+get\b/i,
  /^nginx\s+-t\b/i,
  /^apachectl\s+-t\b/i,
  /^php\s+-v\b/i,
  /^node\s+-v\b/i,
  /^npm\s+ls\b/i,
  /^ls\b/i,
  /^df\b/i,
  /^free\b/i,
  /^uptime\b/i,
  /^hostname\b/i,
  /^ss\s+/i,
  /^netstat\b/i,
  /^ip\s+(addr|route|link)\b/i,
  /^ping\s+-c\s+\d+/i,
  /^curl\s+-sS?\s+(https?:\/\/)/i,
];

const SSH_BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r/i,
  /\brm\s+-[^\s]*r/i,
  /\brm\s+(-[^\s]+\s+)*\/\s*$/,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shred|wipefs)\b/i,
  /\b(curl|wget)\s+[^\s|]+\s*\|\s*(ba)?sh\b/i,
  /\|\s*(ba)?sh\s*$/im,
  /\bchmod\s+(-[^\s]+\s+)*777\s+\//,
  /\buserdel\b/i,
  /\bgroupdel\b/i,
  /\bpasswd\s+root\b/i,
  /\bsystemctl\s+(disable|mask)\s+sshd\b/i,
  /\biptables\s+-F\b/i,
  /\bufw\s+disable\b/i,
  /\bnc\s+-[^\s]*e\s+\/bin\/(ba)?sh\b/i,
  /\bpython3?\s+-c\s+.*\b(os\.system|subprocess|socket)\b/i,
  /\bfind\s+\/[^\s]*\s+-delete\b/i,
  /\b:\(\)\s*\{\s*:\|:&\s*\}\;\:/,
  /\bwget\s+[^\s]+\s+-O\s-\s*\|\s*(ba)?sh\b/i,
  /[\n\r].*(curl|wget|bash|sh)\s/i,
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
  /\/\.env$/i,
  /^\/proc\/[^/]+\/(environ|cmdline)$/i,
  /^\/proc\/self\//i,
  /^\/run\/secrets\//i,
];

export function isGlobalReadOnly(): boolean {
  return optionalEnv("SYSADMIN_READ_ONLY", "false") === "true";
}

export function isConfirmRequired(inventoryDefaults?: Inventory["defaults"]): boolean {
  if (optionalEnv("SYSADMIN_REQUIRE_CONFIRM") === "false") return false;
  if (inventoryDefaults?.requireConfirm === false) return false;
  return true;
}

export function isSshAllowlistEnforced(
  host: SshHost | undefined,
  inventoryDefaults?: Inventory["defaults"],
): boolean {
  if (host?.sshAllowlistMode === false) return false;
  if (host?.sshAllowlistMode === true) return true;
  if (inventoryDefaults?.sshAllowlistMode === false) return false;
  if (inventoryDefaults?.sshAllowlistMode === true) return true;
  return isProductionMode();
}

export function getSshAllowlistPatterns(
  host: SshHost | undefined,
  inventoryDefaults?: Inventory["defaults"],
): RegExp[] {
  const custom = [
    ...(inventoryDefaults?.allowedCommandPatterns ?? []),
    ...(host?.allowedCommandPatterns ?? []),
  ];

  const patterns = [...DEFAULT_SSH_ALLOWLIST];
  for (const entry of custom) {
    patterns.push(compileValidatedCommandPattern(entry, "allowedCommandPatterns"));
  }
  return patterns;
}

export function hostAllowsTool(host: Host, toolName: string): boolean {
  if (host.readOnly && TOOL_CATEGORIES[toolName] !== "read") return false;
  if (host.allowedTools && host.allowedTools.length > 0 && !host.allowedTools.includes(toolName)) {
    return false;
  }
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

  if (host && !hostAllowsTool(host, toolName)) {
    if (host.readOnly) {
      throw new SysadminError(`Tool '${toolName}' blocked: host '${host.id}' is readOnly.`);
    }
    throw new SysadminError(
      `Tool '${toolName}' not in allowedTools for host '${host.id}': [${host.allowedTools!.join(", ")}]`,
    );
  }

  if (inventoryDefaults?.readOnly && TOOL_CATEGORIES[toolName] !== "read" && !host) {
    throw new SysadminError(`Tool '${toolName}' blocked: inventory defaults.readOnly=true.`);
  }
}

export function assertConfirmed(
  confirm: boolean | undefined,
  confirmToken: string | undefined,
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

  if (needsConfirm) {
    assertConfirmToken(confirmToken);
  }
}

export function assertVmPowerAllowed(action: string): void {
  if (isGlobalReadOnly()) {
    throw new SysadminError(`vm-power action '${action}' blocked in read-only mode.`);
  }
}

export function assertSshCommandAllowed(
  command: string,
  host?: SshHost,
  inventoryDefaults?: Inventory["defaults"],
): void {
  const normalized = command.trim();
  if (!normalized) {
    throw new SysadminError("SSH command cannot be empty.");
  }

  if (/[\n\r]/.test(normalized)) {
    throw new SysadminError("Multi-line SSH commands are not allowed.");
  }

  for (const pattern of SSH_BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new SysadminError(`SSH command blocked by security policy.`);
    }
  }

  if (isSshAllowlistEnforced(host, inventoryDefaults)) {
    const allowlist = getSshAllowlistPatterns(host, inventoryDefaults);
    const allowed = allowlist.some((pattern) => pattern.test(normalized));
    if (!allowed) {
      throw new SysadminError(
        "SSH command not in allowlist. Add allowedCommandPatterns to host/inventory or disable sshAllowlistMode for dev.",
      );
    }
  }
}

/** Safe working directories for ssh-exec cwd. File reads must use ssh-read-file. */
const DEFAULT_CWD_ALLOWLIST: RegExp[] = [
  /^\/tmp(\/|$)/,
  /^\/var\/log(\/|$)/,
  /^\/var\/www(\/|$)/,
  /^\/home\/[^/]+(\/|$)/,
  /^\/opt\/[^/]+(\/|$)/,
];

export function assertSshCwdAllowed(cwd?: string): void {
  if (!cwd) return;

  const normalized = cwd.trim();
  if (!normalized.startsWith("/")) {
    throw new SysadminError("cwd must be an absolute path.");
  }
  if (normalized.includes("..")) {
    throw new SysadminError("Path traversal (..) is not allowed in cwd.");
  }

  const blockedCwdPrefixes = ["/etc", "/root", "/proc", "/sys", "/dev", "/.ssh", "/run/secrets"];
  for (const prefix of blockedCwdPrefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      throw new SysadminError(`cwd '${cwd}' is not allowed. Use ssh-read-file for sensitive paths.`);
    }
  }

  if (!DEFAULT_CWD_ALLOWLIST.some((pattern) => pattern.test(normalized))) {
    throw new SysadminError(
      `cwd '${cwd}' not in allowed working directories (/tmp, /var/log, /var/www, /home/*, /opt/*).`,
    );
  }
}

export function normalizePathForPolicy(filePath: string): string {
  let normalized = filePath.trim();
  if (normalized.startsWith("~/")) {
    normalized = `/home/PLACEHOLDER${normalized.slice(1)}`;
  }
  normalized = normalized.replace(/\/+/g, "/");
  return normalized;
}

export function assertSshPathAllowed(filePath: string, confirm?: boolean): void {
  const normalized = normalizePathForPolicy(filePath);

  for (const pattern of SSH_BLOCKED_FILE_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new SysadminError(`Reading '${filePath}' blocked: path is never allowed.`);
    }
  }

  for (const pattern of SSH_SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalized) && confirm !== true) {
      throw new SysadminError(
        `Path '${filePath}' is sensitive. Reintenta ssh-read-file con confirm=true and confirmToken.`,
      );
    }
  }
}

export function parseHostKeyFingerprint(fingerprint: string): {
  algorithm: "sha256" | "md5";
  value: string;
} {
  const trimmed = fingerprint.trim();
  if (trimmed.startsWith("SHA256:") || trimmed.startsWith("sha256:")) {
    return { algorithm: "sha256", value: trimmed.split(":")[1]! };
  }
  if (trimmed.includes(":")) {
    return { algorithm: "md5", value: trimmed.replace(/:/g, "").toLowerCase() };
  }
  return { algorithm: "sha256", value: trimmed };
}

export function fingerprintMatchesKey(
  remoteKey: Buffer,
  expectedFingerprint: string,
): boolean {
  const parsed = parseHostKeyFingerprint(expectedFingerprint);
  if (parsed.algorithm === "md5") {
    const md5 = createHash("md5").update(remoteKey).digest("hex");
    return md5 === parsed.value.toLowerCase();
  }
  const sha256 = createHash("sha256").update(remoteKey).digest("base64");
  return sha256 === parsed.value || sha256.replace(/=+$/, "") === parsed.value.replace(/=+$/, "");
}
