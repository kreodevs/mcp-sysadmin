import { readFileSync } from "node:fs";
import { Client, ConnectConfig } from "ssh2";
import { resolvePrivateKeyPath, SysadminError } from "../../api/utils.js";
import { getSshTimeout } from "../../config/loader.js";
import { SshHost } from "../../config/schema.js";
import { fingerprintMatchesKey } from "../../security/policy.js";
import { isProductionMode } from "../../security/startup.js";

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
};

function buildConnectConfig(host: SshHost): ConnectConfig {
  const config: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: getSshTimeout(),
  };

  if (host.privateKeyPath) {
    const keyPath = resolvePrivateKeyPath(host.privateKeyPath);
    config.privateKey = readFileSync(keyPath, "utf8");
    if (host.passphrase) config.passphrase = host.passphrase;
  } else if (host.password) {
    config.password = host.password;
  } else {
    throw new SysadminError(`SSH host ${host.id} requires privateKeyPath or password`);
  }

  if (host.hostKeyFingerprint) {
    const expected = host.hostKeyFingerprint;
    config.hostVerifier = (key: Buffer) => fingerprintMatchesKey(key, expected);
  } else if (isProductionMode()) {
    throw new SysadminError(
      `SSH host ${host.id}: hostKeyFingerprint required in production mode. Run: ssh-keyscan -H ${host.host} | ssh-keygen -lf -`,
    );
  }

  return config;
}

function withClient<T>(host: SshHost, fn: (client: Client) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on("ready", () => {
        fn(client)
          .then(resolve)
          .catch(reject)
          .finally(() => client.end());
      })
      .on("error", reject)
      .connect(buildConnectConfig(host));
  });
}

export class SshClient {
  async execInternal(
    host: SshHost,
    command: string,
    cwd?: string,
    timeoutMs?: number,
  ): Promise<SshExecResult> {
    const fullCommand = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
    const timeout = timeoutMs ?? getSshTimeout();

    return withClient(host, (client) =>
      new Promise<SshExecResult>((resolve, reject) => {
        let settled = false;
        let streamRef: { close: () => void } | null = null;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          streamRef?.close();
          client.end();
          reject(new SysadminError(`SSH command timed out after ${timeout}ms on ${host.id}`));
        }, timeout);

        client.exec(fullCommand, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              reject(err);
            }
            return;
          }

          streamRef = stream;
          let stdout = "";
          let stderr = "";

          stream.on("close", (code: number | null, signal: string) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            resolve({ stdout, stderr, exitCode: code, signal });
          });

          stream.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });

          stream.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
        });
      }),
    );
  }

  async exec(
    host: SshHost,
    command: string,
    cwd?: string,
    timeoutMs?: number,
  ): Promise<SshExecResult> {
    return this.execInternal(host, command, cwd, timeoutMs);
  }

  async resolveRemotePath(host: SshHost, path: string): Promise<string> {
    const quoted = shellQuote(path);
    const result = await this.execInternal(
      host,
      `if [ -e ${quoted} ] || [ -L ${quoted} ]; then readlink -f ${quoted}; else echo ${quoted}; fi`,
      undefined,
      10_000,
    );

    const resolved = result.stdout.trim().split("\n").pop()?.trim();
    if (!resolved) {
      throw new SysadminError(`Could not resolve remote path on ${host.id}: ${path}`);
    }
    if (resolved.includes("..")) {
      throw new SysadminError(`Resolved path contains traversal on ${host.id}: ${resolved}`);
    }
    return resolved;
  }

  async readFile(host: SshHost, path: string, maxBytes = 256_000): Promise<string> {
    const resolved = await this.resolveRemotePath(host, path);
    return this.readResolvedFile(host, resolved, maxBytes);
  }

  async readResolvedFile(host: SshHost, resolvedPath: string, maxBytes = 256_000): Promise<string> {
    const result = await this.execInternal(
      host,
      `if [ -f ${shellQuote(resolvedPath)} ]; then head -c ${maxBytes} ${shellQuote(resolvedPath)}; else echo "__FILE_NOT_FOUND__"; fi`,
    );

    if (result.stdout.trim() === "__FILE_NOT_FOUND__") {
      throw new SysadminError(`File not found on ${host.id}: ${resolvedPath}`);
    }

    return result.stdout;
  }

  async getHostStats(host: SshHost) {
    const script = [
      "echo \"__STATS_START__\"",
      "hostname",
      "uptime -s 2>/dev/null || uptime",
      "free -m | awk '/Mem:/ {print $2,$3,$7}'",
      "df -h / | awk 'NR==2 {print $2,$3,$5}'",
      "nproc 2>/dev/null || getconf _NPROCESSORS_ONLN",
      "cat /proc/loadavg 2>/dev/null || echo '0 0 0'",
    ].join("; ");

    const result = await this.execInternal(host, script);
    const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const startIdx = lines.indexOf("__STATS_START__");

    return {
      hostId: host.id,
      hostname: lines[startIdx + 1] ?? host.host,
      uptime: lines[startIdx + 2] ?? "",
      memory: parseMemoryLine(lines[startIdx + 3]),
      disk: parseDiskLine(lines[startIdx + 4]),
      cpuCores: Number(lines[startIdx + 5] ?? 0) || undefined,
      loadAverage: lines[startIdx + 6] ?? "",
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseMemoryLine(line?: string) {
  if (!line) return undefined;
  const [totalMb, usedMb, availableMb] = line.split(/\s+/).map(Number);
  return { totalMb, usedMb, availableMb };
}

function parseDiskLine(line?: string) {
  if (!line) return undefined;
  const [total, used, usePercent] = line.split(/\s+/);
  return { total, used, usePercent };
}
