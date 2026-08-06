import { optionalEnv } from "../api/utils.js";
import { Inventory } from "../config/schema.js";

export function isProductionMode(): boolean {
  return optionalEnv("SYSADMIN_PRODUCTION_MODE", "false") === "true";
}

export function validateProductionConfig(inventory: Inventory): void {
  const warnings: string[] = [];

  if (isProductionMode()) {
    if (!optionalEnv("SYSADMIN_CONFIRM_TOKEN")) {
      warnings.push(
        "PRODUCTION: SYSADMIN_CONFIRM_TOKEN is not set. Destructive ops rely only on confirm=true (weak against prompt injection).",
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
      if (host.provider === "ssh" && !("hostKeyFingerprint" in host && host.hostKeyFingerprint)) {
        warnings.push(
          `PRODUCTION: SSH host '${host.id}' has no hostKeyFingerprint (MITM risk).`,
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
