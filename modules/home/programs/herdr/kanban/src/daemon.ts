// herdr-kanban's daemon: the local API, the scheduler, and (when enabled) MCP on the LAN.
import { homedir } from "node:os";
import { Kanban } from "./kanban.ts";
import { localApi } from "./local-api.ts";
import { mcpHttp } from "./mcp.ts";
import { Lan } from "./lan.ts";

export const DEFAULT_PORT = 7742; // nix-editor's lsp-bridge has 7741
export const DEFAULT_MCP_PORT = 7743;

export async function main(env = process.env) {
  const dir = env.HERDR_KANBAN_STATE_DIR ?? `${homedir()}/.local/share/herdr-kanban`;
  const port = Number(env.HERDR_KANBAN_PORT ?? DEFAULT_PORT);
  const mcpPort = Number(env.HERDR_KANBAN_MCP_PORT ?? DEFAULT_MCP_PORT);
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

  const k = new Kanban({ dir, cli: env.HERDR_KANBAN_CLI, log, tickMs: env.HERDR_KANBAN_TICK_MS ? Number(env.HERDR_KANBAN_TICK_MS) : undefined });
  const lan = new Lan(mcpHttp(k, (client) => log(`pairing asked by ${client}`)), mcpPort, env.HERDR_KANBAN_NAME ?? "Herdr Kanban", log);
  const api = localApi(k, {
    onSettings: () => lan.set(k.store.settings().mcpEnabled),
    mcp: () => lan.status(),
  });

  await new Promise<void>((resolve, reject) => {
    api.once("error", reject);
    api.listen(port, "127.0.0.1", () => resolve());
  });
  log(`herdr-kanban on 127.0.0.1:${port}, state in ${dir}`);
  await lan.set(k.store.settings().mcpEnabled);
  k.start();

  const quit = () => {
    lan.stop();
    k.stop();
    k.store.saveNow();
    process.exit(0);
  };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}

if (import.meta.main) await main();
