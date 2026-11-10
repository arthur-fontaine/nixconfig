// The LAN side, on only while MCP is enabled: the MCP listener on every interface and
// a Bonjour announcement (`dns-sd -R`, kept alive) so agents on the network find it.
import { spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import { connect } from "node:net";

// macOS lets a wildcard listener share a port with another program's loopback one, so
// listen() wouldn't fail: local clients would reach the other program. Ask first.
function taken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

export class Lan {
  private server: Server;
  private port: number;
  private name: string;
  private log: (m: string) => void;
  private dnsSd: ChildProcess | null = null;
  private want = false;
  listening = false;
  error: string | null = null;

  constructor(server: Server, port: number, name: string, log: (m: string) => void) {
    this.server = server;
    this.port = port;
    this.name = name;
    this.log = log;
  }

  status() { return { enabled: this.want, listening: this.listening, port: this.port, error: this.error }; }

  async set(enabled: boolean) {
    this.want = enabled;
    if (enabled && !this.listening) {
      try {
        if (await taken(this.port)) throw new Error(`another program already listens on port ${this.port}`);
        await new Promise<void>((resolve, reject) => {
          this.server.once("error", reject);
          this.server.listen(this.port, "0.0.0.0", () => { this.server.off("error", reject); resolve(); });
        });
        this.listening = true;
        this.error = null;
        this.log(`MCP listening on 0.0.0.0:${this.port}`);
        this.announce();
      } catch (e) {
        this.error = (e as Error).message;
        this.log(`MCP listen failed: ${this.error}`);
      }
    } else if (!enabled && this.listening) {
      this.dnsSd?.kill();
      this.dnsSd = null;
      this.server.closeAllConnections();
      await new Promise((r) => this.server.close(r));
      this.listening = false;
      this.log("MCP stopped");
    }
  }

  private announce() {
    if (!this.want || this.dnsSd) return;
    const child = spawn("dns-sd", ["-R", this.name, "_herdr-kanban._tcp", "local", String(this.port), "path=/mcp"], { stdio: "ignore" });
    this.dnsSd = child;
    child.on("exit", (code) => {
      if (this.dnsSd !== child) return;
      this.dnsSd = null;
      if (this.want) {
        this.log(`dns-sd exited (${code}), announcing again`);
        setTimeout(() => this.announce(), 2000);
      }
    });
    child.on("error", (e) => this.log(`dns-sd: ${e.message}`));
  }

  stop() { this.dnsSd?.kill(); this.dnsSd = null; }
}
