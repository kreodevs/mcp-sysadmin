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
    "password",
    "passphrase",
    "privateKeyPath",
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
    if (PROXMOX_SENSITIVE_KEYS.has(key.toLowerCase())) {
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
    result[key] = value;
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
  return false;
}
