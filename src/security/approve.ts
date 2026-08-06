import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { optionalEnv, SysadminError } from "../api/utils.js";
import { tokensEqual } from "./startup.js";

type ApproveRecord = {
  token: string;
  expiresAt: number;
};

function approveFilePath(): string {
  const custom = optionalEnv("SYSADMIN_APPROVE_FILE");
  if (custom) return resolve(custom);
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new SysadminError("Cannot resolve approve file path: HOME not set");
  return resolve(home, ".config/mcp-sysadmin/approve.json");
}

function readApproveRecord(): ApproveRecord | null {
  const path = approveFilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ApproveRecord;
  } catch {
    return null;
  }
}

export function isValidOneTimeApprove(provided: string): boolean {
  const record = readApproveRecord();
  if (!record) return false;
  if (Date.now() > record.expiresAt) return false;
  return tokensEqual(record.token, provided);
}

export function assertConfirmToken(confirmToken?: string): void {
  const expected = optionalEnv("SYSADMIN_CONFIRM_TOKEN");
  if (!expected) return;

  if (confirmToken && tokensEqual(expected, confirmToken)) return;
  if (confirmToken && isValidOneTimeApprove(confirmToken)) return;

  throw new SysadminError(
    "Invalid or missing confirmToken. Use SYSADMIN_CONFIRM_TOKEN or run: scripts/mcp-approve.sh",
  );
}
