import { run } from "./run.ts";

/** Available RAM from `vm_stat`: free, inactive, speculative and purgeable pages, in GB. */
export function parseVmStat(text: string): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!size) return null;
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  const free = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
  return (free * size) / 1024 ** 3;
}

export async function freeRamGB(): Promise<number | null> {
  const r = await run("vm_stat", [], { timeout: 5000 });
  return r.code === 0 ? parseVmStat(r.stdout) : null;
}
