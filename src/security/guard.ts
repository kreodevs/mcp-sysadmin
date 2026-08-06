import { SysadminError } from "../api/utils.js";
import { auditBlocked, auditToolStart } from "./audit.js";
import { assertRateLimit } from "./ratelimit.js";
import { assertToolAllowed } from "./policy.js";
import { Host, Inventory } from "../config/schema.js";

type ToolGuardOptions = {
  toolName: string;
  hostId?: string;
  host?: Host;
  defaults?: Inventory["defaults"];
  action?: string;
  beforeCheck?: () => void;
};

export function guardToolAccess(options: ToolGuardOptions): void {
  try {
    options.beforeCheck?.();
    assertToolAllowed(options.toolName, options.host, options.defaults);
    assertRateLimit(options.toolName, options.hostId);
    auditToolStart(options.toolName, options.hostId, options.action);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    auditBlocked(options.toolName, message, options.hostId);
    throw error instanceof SysadminError ? error : new SysadminError(message);
  }
}
