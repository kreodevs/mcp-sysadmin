const PROXMOX_SENSITIVE_KEYS = new Set([
  "cipassword",
  "sshkeys",
  "hookscript",
  "template",
  "description",
  "notes",
  "ipconfig",
  "net",
  "nameserver",
  "searchdomain",
  "password",
  "token",
  "secret",
  "ciuser",
  "cicustom",
  "cloudinit",
  "meta",
  "virtio",
  "efidisk0",
  "smbios1",
]);

const VIRTUALIZOR_SENSITIVE_KEYS = new Set([
  "pass",
  "password",
  "rootpass",
  "vncpass",
  "adminapikey",
  "adminapipass",
  "apikey",
  "apipass",
]);

export function sanitizeHostRecord(host: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...host };
  for (const key of [
    "tokenSecret",
    "tokenId",
    "apiKey",
    "apiPass",
    "apiToken",
    "password",
    "passphrase",
    "privateKeyPath",
    "hostKeyFingerprint",
    "accountId",
  ]) {
    if (key in copy) {
      copy[key] = "[configured]";
    }
  }
  return copy;
}

export function sanitizeProxmoxVmPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    const keyLower = key.toLowerCase();
    if (PROXMOX_SENSITIVE_KEYS.has(keyLower) || keyLower.includes("cloudinit")) {
      result[key] = "[redacted]";
      continue;
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeProxmoxVmPayload(value as Record<string, unknown>);
    } else if (typeof value === "string" && looksSensitive(key, value)) {
      result[key] = "[redacted]";
    } else {
      result[key] = value;
    }
  }

  return result;
}

export function sanitizeVirtualizorPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (VIRTUALIZOR_SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = "[redacted]";
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeVirtualizorPayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

export function sanitizeRawPayload(payload: unknown, maxDepth = 4): unknown {
  if (maxDepth <= 0) return "[truncated]";
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeRawPayload(item, maxDepth - 1));
  }
  if (typeof payload !== "object") {
    if (typeof payload === "string" && payload.length > 500) {
      return `${payload.slice(0, 500)}…[truncated]`;
    }
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const keyLower = key.toLowerCase();
    if (
      keyLower.includes("pass") ||
      keyLower.includes("secret") ||
      keyLower.includes("token") ||
      keyLower.includes("key")
    ) {
      result[key] = "[redacted]";
    } else {
      result[key] = sanitizeRawPayload(value, maxDepth - 1);
    }
  }
  return result;
}

function looksSensitive(key: string, value: string): boolean {
  const keyLower = key.toLowerCase();
  if (keyLower.includes("pass") || keyLower.includes("secret") || keyLower.includes("token")) {
    return true;
  }
  if (value.includes("BEGIN ") && value.includes(" PRIVATE KEY")) {
    return true;
  }
  if (value.length > 200 && /^[A-Za-z0-9+/=]+$/.test(value)) {
    return true;
  }
  return false;
}
