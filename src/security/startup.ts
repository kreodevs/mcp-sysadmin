import { timingSafeEqual } from "node:crypto";
import { optionalEnv, SysadminError } from "../api/utils.js";
import { Inventory } from "../config/schema.js";

export function isProductionMode(): boolean {
  return optionalEnv("SYSADMIN_PRODUCTION_MODE", "false") === "true";
}

export function validateProductionConfig(inventory: Inventory): void {
  validateInventoryCommandPatterns(inventory);
  const warnings: string[] = [];

  if (isProductionMode()) {
    if (!optionalEnv("SYSADMIN_CONFIRM_TOKEN")) {
      throw new Error(
        "Production mode requires SYSADMIN_CONFIRM_TOKEN in MCP env. Generate with: openssl rand -hex 32",
      );
    }
    if (optionalEnv("SYSADMIN_REQUIRE_CONFIRM") === "false") {
      warnings.push("PRODUCTION: SYSADMIN_REQUIRE_CONFIRM=false disables confirmation gates.");
    }
    if (optionalEnv("SYSADMIN_READ_ONLY") === "true") {
      warnings.push("PRODUCTION: SYSADMIN_READ_ONLY=true — write tools are disabled globally.");
    }

    for (const host of inventory.hosts) {
      if (host.provider === "ssh" && "password" in host && host.password) {
        throw new Error(
          `Production mode: SSH password auth not allowed for host '${host.id}'. Use privateKeyPath.`,
        );
      }
      if (host.provider === "ssh" && !host.hostKeyFingerprint) {
        throw new Error(
          `Production mode: SSH host '${host.id}' requires hostKeyFingerprint. Run: ssh-keyscan -H ${host.host} | ssh-keygen -lf -`,
        );
      }
      if (host.provider === "proxmox" && host.verifySsl === false) {
        warnings.push(`PRODUCTION: Proxmox host '${host.id}' has verifySsl=false.`);
      }
    }
  } else {
    if (!optionalEnv("SYSADMIN_CONFIRM_TOKEN")) {
      warnings.push("Set SYSADMIN_CONFIRM_TOKEN and SYSADMIN_PRODUCTION_MODE=true before production use.");
    }
  }

  for (const line of warnings) {
    process.stderr.write(`[mcp-sysadmin:warn] ${line}\n`);
  }
}

export function validateInventoryCommandPatterns(inventory: Inventory): void {
  for (const pattern of inventory.defaults?.allowedCommandPatterns ?? []) {
    compileValidatedCommandPattern(pattern, "inventory.defaults.allowedCommandPatterns");
  }

  for (const host of inventory.hosts) {
    if (host.provider !== "ssh") continue;
    for (const pattern of host.allowedCommandPatterns ?? []) {
      compileValidatedCommandPattern(pattern, `host '${host.id}'.allowedCommandPatterns`);
    }
  }
}

const MAX_COMMAND_PATTERN_LENGTH = 200;

const FORBIDDEN_PATTERN_MARKERS = [
  ".*",
  ".+",
  "(.*)",
  "(.+)",
  ".{0,}",
  "[\\s\\S]",
  "[\\d\\D]",
  "[\\w\\W]",
];

export function compileValidatedCommandPattern(pattern: string, context: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new SysadminError(`Empty command pattern in ${context}.`);
  }
  if (trimmed.length > MAX_COMMAND_PATTERN_LENGTH) {
    throw new SysadminError(
      `Command pattern too long in ${context} (max ${MAX_COMMAND_PATTERN_LENGTH} chars).`,
    );
  }

  for (const marker of FORBIDDEN_PATTERN_MARKERS) {
    if (trimmed.includes(marker)) {
      throw new SysadminError(
        `Overly broad command pattern '${trimmed}' in ${context}. Explicit patterns only.`,
      );
    }
  }

  if (/^\.\*$|^\(\.\*\)$|^\.\+$|^\(\.\+\)$/.test(trimmed)) {
    throw new SysadminError(`Overly broad command pattern '${trimmed}' in ${context}.`);
  }

  try {
    return new RegExp(trimmed, "i");
  } catch {
    throw new SysadminError(`Invalid regex in ${context}: ${trimmed}`);
  }
}

export function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
