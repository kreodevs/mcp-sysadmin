import axios, { AxiosError } from "axios";

export type JsonRecord = Record<string, unknown>;

export class SysadminError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "SysadminError";
  }
}

export function optionalEnv(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new SysadminError(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const envValue = process.env[name];
    if (!envValue) {
      throw new SysadminError(`Missing environment variable referenced in inventory: ${name}`);
    }
    return envValue;
  });
}

export function expandEnvDeep<T>(value: T): T {
  if (typeof value === "string") {
    return expandEnv(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvDeep(item)) as T;
  }
  if (value && typeof value === "object") {
    const result: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = expandEnvDeep(item);
    }
    return result as T;
  }
  return value;
}

export function toArray<T = JsonRecord>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];

  const record = value as JsonRecord;
  for (const key of ["data", "items", "servers", "nodes", "vms", "vs"]) {
    if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
}

export function unwrapData<T = unknown>(value: unknown): T {
  if (value && typeof value === "object" && "data" in value) {
    return (value as JsonRecord).data as T;
  }
  return value as T;
}

export function firstString(record: JsonRecord, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return fallback;
}

export function firstNumber(record: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

export function jsonContent(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function toolError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: formatError(error),
      },
    ],
  };
}

export function formatError(error: unknown): string {
  if (error instanceof SysadminError) {
    return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
  }

  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const details = axiosError.response?.data;
    const message =
      typeof details === "object" && details && "message" in details
        ? String((details as JsonRecord).message)
        : axiosError.message;
    return status ? `${message} (HTTP ${status})` : message;
  }

  return error instanceof Error ? error.message : String(error);
}

export function resolvePath(path: string): string {
  if (path.includes("..")) {
    throw new SysadminError("Path traversal (..) is not allowed in file paths");
  }

  if (path.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) throw new SysadminError("Cannot expand ~ in path: HOME not set");
    return `${home}/${path.slice(2)}`;
  }
  return path;
}

export function resolvePrivateKeyPath(path: string): string {
  if (path.includes("..")) {
    throw new SysadminError("Path traversal (..) is not allowed in privateKeyPath");
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new SysadminError("Cannot resolve privateKeyPath: HOME not set");
  }

  const sshDir = `${home}/.ssh`;

  if (path.startsWith("~/")) {
    const resolved = `${home}/${path.slice(2)}`;
    if (!resolved.startsWith(`${sshDir}/`)) {
      throw new SysadminError("privateKeyPath must be under ~/.ssh/");
    }
    return resolved;
  }

  if (path.startsWith(`${sshDir}/`)) {
    return path;
  }

  throw new SysadminError("privateKeyPath must be under ~/.ssh/ (e.g. ~/.ssh/id_ed25519)");
}
