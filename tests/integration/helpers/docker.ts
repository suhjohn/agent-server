import { spawnSync } from "node:child_process";

export function canRunDocker(): boolean {
  try {
    const result = spawnSync("docker", ["version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}


