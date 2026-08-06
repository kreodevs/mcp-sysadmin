import { optionalEnv } from "../api/utils.js";

export type AuditEntry = {
  ts: string;
  tool: string;
  hostId?: string;
  action?: string;
  outcome: "allowed" | "blocked" | "error";
  detail?: string;
};

export function auditLog(entry: Omit<AuditEntry, "ts">): void {
  const level = optionalEnv("SYSADMIN_LOG_LEVEL", "info");
  if (level === "error" && entry.outcome !== "error" && entry.outcome !== "blocked") {
    return;
  }

  const record: AuditEntry = { ts: new Date().toISOString(), ...entry };
  process.stderr.write(`[mcp-sysadmin:audit] ${JSON.stringify(record)}\n`);
}

export function auditToolStart(tool: string, hostId?: string, action?: string): void {
  auditLog({ tool, hostId, action, outcome: "allowed", detail: "invoked" });
}

export function auditBlocked(tool: string, reason: string, hostId?: string): void {
  auditLog({ tool, hostId, outcome: "blocked", detail: reason });
}

export function auditError(tool: string, error: unknown, hostId?: string): void {
  const detail = error instanceof Error ? error.message : String(error);
  auditLog({ tool, hostId, outcome: "error", detail });
}
