import axios, { AxiosInstance } from "axios";
import {
  firstString,
  JsonRecord,
  SysadminError,
  toArray,
} from "../../api/utils.js";
import { getHttpTimeout } from "../../config/loader.js";
import { CloudflareHost } from "../../config/schema.js";

type CloudflareResponse<T> = {
  success: boolean;
  result: T;
  errors?: JsonRecord[];
  messages?: JsonRecord[];
};

export type DnsRecordInput = {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  comment?: string;
};

export class CloudflareClient {
  private readonly http: AxiosInstance;
  private readonly host: CloudflareHost;

  constructor(host: CloudflareHost) {
    this.host = host;
    this.http = axios.create({
      baseURL: "https://api.cloudflare.com/client/v4",
      timeout: getHttpTimeout(),
      headers: {
        Authorization: `Bearer ${host.apiToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    data?: unknown,
  ): Promise<T> {
    try {
      const response = await this.http.request<CloudflareResponse<T>>({ method, url: path, data });
      const body = response.data;

      if (!body.success) {
        const errors = body.errors?.map((e) => firstString(e, ["message"], JSON.stringify(e))).join("; ");
        throw new SysadminError(`Cloudflare API error: ${errors ?? "unknown"}`, response.status, body.errors);
      }

      return body.result;
    } catch (error) {
      if (error instanceof SysadminError) throw error;
      if (axios.isAxiosError(error)) {
        const body = error.response?.data as CloudflareResponse<unknown> | undefined;
        const errors = body?.errors?.map((e) => firstString(e as JsonRecord, ["message"])).join("; ");
        throw new SysadminError(
          `Cloudflare request failed: ${errors ?? error.message}`,
          error.response?.status,
          body?.errors,
        );
      }
      throw error;
    }
  }

  resolveZoneId(zoneId?: string): string {
    const resolved = zoneId ?? this.host.defaultZoneId;
    if (!resolved) {
      throw new SysadminError(
        "zoneId required (pass as parameter or set defaultZoneId on Cloudflare host in inventory).",
      );
    }
    return resolved;
  }

  async verifyToken(): Promise<{ status: string; expiresOn?: string }> {
    const result = await this.request<JsonRecord>("GET", "/user/tokens/verify");
    return {
      status: firstString(result, ["status"], "unknown"),
      expiresOn: firstString(result, ["expires_on"]) || undefined,
    };
  }

  async listZones(name?: string) {
    const query = name ? `?name=${encodeURIComponent(name)}&per_page=50` : "?per_page=50";
    const zones = await this.request<JsonRecord[]>("GET", `/zones${query}`);
    return zones.map((zone) => ({
      id: firstString(zone, ["id"]),
      name: firstString(zone, ["name"]),
      status: firstString(zone, ["status"]),
      paused: zone.paused === true,
      type: firstString(zone, ["type"]),
      nameServers: toArray<string>(zone.name_servers),
    }));
  }

  async listDnsRecords(zoneId: string, type?: string, name?: string) {
    const params = new URLSearchParams({ per_page: "100" });
    if (type) params.set("type", type);
    if (name) params.set("name", name);

    const records = await this.request<JsonRecord[]>(
      "GET",
      `/zones/${zoneId}/dns_records?${params.toString()}`,
    );

    return records.map((record) => mapDnsRecord(record));
  }

  async getDnsRecord(zoneId: string, recordId: string) {
    const record = await this.request<JsonRecord>("GET", `/zones/${zoneId}/dns_records/${recordId}`);
    return mapDnsRecord(record);
  }

  async createDnsRecord(zoneId: string, input: DnsRecordInput) {
    const record = await this.request<JsonRecord>("POST", `/zones/${zoneId}/dns_records`, input);
    return mapDnsRecord(record);
  }

  async updateDnsRecord(zoneId: string, recordId: string, input: Partial<DnsRecordInput>) {
    const record = await this.request<JsonRecord>(
      "PATCH",
      `/zones/${zoneId}/dns_records/${recordId}`,
      input,
    );
    return mapDnsRecord(record);
  }

  async deleteDnsRecord(zoneId: string, recordId: string) {
    const result = await this.request<{ id: string }>("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
    return { zoneId, recordId: result.id, deleted: true };
  }

  async purgeCache(zoneId: string, purgeEverything = true, files?: string[]) {
    const body = purgeEverything ? { purge_everything: true } : { files: files ?? [] };
    const result = await this.request<JsonRecord>("POST", `/zones/${zoneId}/purge_cache`, body);
    return {
      zoneId,
      purged: true,
      id: firstString(result, ["id"]),
    };
  }

  async listWafRules(zoneId: string) {
    const rulesets = await this.request<JsonRecord[]>("GET", `/zones/${zoneId}/rulesets`);
    return rulesets.map((ruleset) => ({
      id: firstString(ruleset, ["id"]),
      name: firstString(ruleset, ["name"]),
      description: firstString(ruleset, ["description"]),
      kind: firstString(ruleset, ["kind"]),
      phase: firstString(ruleset, ["phase"]),
      version: firstString(ruleset, ["version"]),
    }));
  }

  async listNetwork(zoneId?: string) {
    const resolvedZoneId = this.resolveZoneId(zoneId);
    const records = await this.listDnsRecords(resolvedZoneId);
    return {
      zoneId: resolvedZoneId,
      records: records.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        content: r.content,
        proxied: r.proxied,
      })),
    };
  }
}

function mapDnsRecord(record: JsonRecord) {
  return {
    id: firstString(record, ["id"]),
    type: firstString(record, ["type"]),
    name: firstString(record, ["name"]),
    content: firstString(record, ["content"]),
    ttl: record.ttl as number | undefined,
    proxied: record.proxied === true,
    priority: record.priority as number | undefined,
    comment: firstString(record, ["comment"]) || undefined,
    createdOn: firstString(record, ["created_on"]) || undefined,
    modifiedOn: firstString(record, ["modified_on"]) || undefined,
  };
}
