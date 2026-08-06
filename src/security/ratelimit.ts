import { optionalEnv, SysadminError } from "../api/utils.js";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function windowMs(): number {
  return Number(optionalEnv("SYSADMIN_RATE_LIMIT_WINDOW_MS", "60000"));
}

function maxRequests(): number {
  return Number(optionalEnv("SYSADMIN_RATE_LIMIT_MAX", "30"));
}

export function assertRateLimit(tool: string, hostId?: string): void {
  const key = `${tool}:${hostId ?? "*"}`;
  const now = Date.now();
  const window = windowMs();
  const max = maxRequests();

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + window };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  if (bucket.count > max) {
    throw new SysadminError(
      `Rate limit exceeded for '${tool}'${hostId ? ` on ${hostId}` : ""}: max ${max} calls per ${window / 1000}s.`,
    );
  }
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}
