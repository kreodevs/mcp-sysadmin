import { SysadminError } from "../../api/utils.js";
import { SshHost } from "../../config/schema.js";
import { SshClient } from "./client.js";

const UNIT_PATTERN = /^[a-zA-Z0-9@._-]+$/;
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const LOG_PATH_PATTERN = /^\/var\/log\/[a-zA-Z0-9/_.-]+$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class SshDiagnostics {
  constructor(private readonly ssh: SshClient) {}

  async tailLog(host: SshHost, lines: number, unit?: string, path?: string) {
    if (unit && path) throw new SysadminError("Provide unit or path, not both.");
    if (unit) {
      if (!UNIT_PATTERN.test(unit)) throw new SysadminError("Invalid systemd unit name.");
      const cmd = `journalctl -u ${shellQuote(unit)} -n ${lines} --no-pager 2>/dev/null || systemctl status ${shellQuote(unit)} --no-pager -n ${lines}`;
      const result = await this.ssh.execInternal(host, cmd);
      return { source: "journalctl", unit, lines, ...pickOutput(result) };
    }
    if (path) {
      if (!LOG_PATH_PATTERN.test(path)) {
        throw new SysadminError("Log path must be under /var/log/ with safe characters.");
      }
      const cmd = `tail -n ${lines} ${shellQuote(path)}`;
      const result = await this.ssh.execInternal(host, cmd);
      return { source: "file", path, lines, ...pickOutput(result) };
    }
    throw new SysadminError("unit or path is required for ssh-tail-log.");
  }

  async listFirewallRules(host: SshHost) {
    const cmd = "ufw status verbose 2>/dev/null || nft list ruleset 2>/dev/null || iptables -L -n 2>/dev/null || echo 'NO_FIREWALL_TOOL'";
    const result = await this.ssh.execInternal(host, cmd);
    return { ...pickOutput(result), tool: result.stdout.includes("NO_FIREWALL") ? "none" : "detected" };
  }

  async listSystemdUnits(host: SshHost, state: "failed" | "running" | "all" = "failed") {
    const cmd =
      state === "failed"
        ? "systemctl --failed --no-pager --no-legend 2>/dev/null"
        : state === "running"
          ? "systemctl list-units --state=running --no-pager --no-legend 2>/dev/null | head -50"
          : "systemctl list-units --no-pager --no-legend 2>/dev/null | head -80";
    const result = await this.ssh.execInternal(host, cmd);
    const units = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return { state, count: units.length, units, stderr: result.stderr };
  }

  async certStatus(host: SshHost, domain?: string) {
    if (domain && !HOSTNAME_PATTERN.test(domain)) {
      throw new SysadminError("Invalid domain for cert-status.");
    }
    const domainArg = domain ? shellQuote(domain) : "";
    const cmd = domain
      ? `(certbot certificates -d ${domainArg} 2>/dev/null || echo CERTBOT_ND); echo '---'; echo | openssl s_client -servername ${domainArg} -connect ${domainArg}:443 2>/dev/null | openssl x509 -noout -dates 2>/dev/null || echo OPENSSL_ND`
      : "certbot certificates 2>/dev/null || ls -1 /etc/letsencrypt/live 2>/dev/null || echo NO_CERTBOT";
    const result = await this.ssh.execInternal(host, cmd);
    return { domain, ...pickOutput(result) };
  }

  async dnsLookup(host: SshHost, hostname: string) {
    if (!HOSTNAME_PATTERN.test(hostname)) throw new SysadminError("Invalid hostname.");
    const cmd = `getent hosts ${shellQuote(hostname)} 2>/dev/null || nslookup ${shellQuote(hostname)} 2>/dev/null || host ${shellQuote(hostname)} 2>/dev/null`;
    const result = await this.ssh.execInternal(host, cmd);
    return { hostname, ...pickOutput(result) };
  }

  async checkEndpoint(host: SshHost, target: string, port = 443, useHttps = true) {
    if (!HOSTNAME_PATTERN.test(target)) throw new SysadminError("Invalid target host.");
    if (port < 1 || port > 65535) throw new SysadminError("Invalid port.");
    const cmd = useHttps
      ? `curl -sS -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 5 https://${target}:${port}/ 2>&1 || true`
      : `nc -z -w 3 ${shellQuote(target)} ${port} >/dev/null 2>&1 && echo OPEN || echo CLOSED`;
    const result = await this.ssh.execInternal(host, cmd);
    return { target, port, useHttps, ...pickOutput(result) };
  }

  async listCron(host: SshHost) {
    const cmd = "(crontab -l 2>/dev/null || echo 'no user crontab'); echo '---'; ls -1 /etc/cron.d 2>/dev/null || true";
    const result = await this.ssh.execInternal(host, cmd);
    return pickOutput(result);
  }

  async listTimers(host: SshHost) {
    const cmd = "systemctl list-timers --all --no-pager --no-legend 2>/dev/null | head -50";
    const result = await this.ssh.execInternal(host, cmd);
    const timers = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return { count: timers.length, timers, stderr: result.stderr };
  }

  async dockerComposePs(host: SshHost, projectDir?: string) {
    if (projectDir) {
      if (!projectDir.startsWith("/") || projectDir.includes("..")) {
        throw new SysadminError("projectDir must be absolute without ..");
      }
      const allowed = /^\/(opt|var\/www|home\/[^/]+|tmp)\//.test(projectDir);
      if (!allowed) throw new SysadminError("projectDir not in allowed paths.");
    }
    const cmd = projectDir
      ? `cd ${shellQuote(projectDir)} && docker compose ps 2>/dev/null || docker-compose ps 2>/dev/null`
      : "docker compose ps 2>/dev/null || docker-compose ps 2>/dev/null || docker ps --format 'table {{.Names}}\\t{{.Status}}' 2>/dev/null";
    const result = await this.ssh.execInternal(host, cmd);
    return { projectDir, ...pickOutput(result) };
  }
}

function pickOutput(result: { stdout: string; stderr: string; exitCode: number | null }) {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}
