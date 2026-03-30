import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

export function getPackageRoot() {
  const url = new URL("../..", import.meta.url);
  const decoded = decodeURIComponent(url.pathname);
  return decoded.replace(/^\/([A-Z]:)/, "$1").replace(/\/$/, "");
}

export function getNodeMajor() {
  return parseInt(process.versions.node.split(".")[0], 10);
}
