// Files attached to cards. The daemon keeps its own copies: a file is staged first (the card
// dialog stages what's pasted, dropped or picked before the card is saved), then a card adopts
// it into attachments/<card id>/, under its own name so the orchestrator can open it by path.
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { StoreError } from "./store.ts";
import type { Attachment } from "./types.ts";

export const MAX_ATTACHMENT = 512 * 1024 * 1024;
const STAGED_FOR = 86_400_000;
const ID = /^a[0-9a-f]{12}$/;
const CARD_DIR = /^k\d+$/;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  pdf: "application/pdf", zip: "application/zip", json: "application/json",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", log: "text/plain", html: "text/html",
};
export const mimeOf = (name: string) => MIME[extname(name).slice(1).toLowerCase()] ?? null;

/** A file's own name, without folders, control characters or a leading dot, 120 characters at most. */
export function safeName(name: string): string {
  let n = basename(String(name).replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!n || n === "." || n === "..") return "file";
  if (n.startsWith(".")) n = `_${n.slice(1)}`;
  if (n.length > 120) {
    const ext = extname(n).slice(0, 16);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

// "shot.png", then "shot (2).png", … in a folder.
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`;
}

export class Attachments {
  readonly root: string;
  readonly max: number;
  constructor(root: string, max = MAX_ATTACHMENT) { this.root = root; this.max = max; }

  private get staging() { return join(this.root, ".staging"); }
  cardDir(cardId: string) { return join(this.root, cardId); }

  private mustId(id: unknown): string {
    if (typeof id !== "string" || !ID.test(id)) throw new StoreError(`bad attachment id ${String(id).slice(0, 40)}`);
    return id;
  }

  /** Copies a local file in; the original stays where it is. */
  async stage(src: string, name?: string): Promise<Attachment> {
    if (typeof src !== "string" || !src.startsWith("/")) throw new StoreError("path must be an absolute path");
    const st = await stat(src).catch(() => null);
    if (!st) throw new StoreError(`no file at ${src}`, 404);
    if (!st.isFile()) throw new StoreError(`${src} isn't a file`);
    if (st.size > this.max) throw new StoreError(`${basename(src)} is over ${Math.round(this.max / 1024 / 1024)} MB`, 413);
    const id = `a${randomBytes(6).toString("hex")}`;
    const file = safeName(name || src);
    const dir = join(this.staging, id);
    await mkdir(dir, { recursive: true });
    try { await copyFile(src, join(dir, file)); } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw new StoreError(`couldn't copy ${src}: ${(e as Error).message}`);
    }
    return { id, name: file, size: st.size, mime: mimeOf(file), path: join(dir, file) };
  }

  /** The staged file of that id, or null. */
  staged(id: unknown): Attachment | null {
    const dir = join(this.staging, this.mustId(id));
    const name = existsSync(dir) ? readdirSync(dir)[0] : undefined;
    if (!name) return null;
    const path = join(dir, name);
    return { id: id as string, name, size: statSync(path).size, mime: mimeOf(name), path };
  }

  unstage(id: string) { rmSync(join(this.staging, this.mustId(id)), { recursive: true, force: true }); }

  /** Moves a staged file into the card's folder. */
  adopt(cardId: string, staged: Attachment): Attachment {
    const dir = this.cardDir(cardId);
    mkdirSync(dir, { recursive: true });
    const name = freeName(dir, staged.name);
    renameSync(staged.path, join(dir, name));
    rmSync(join(this.staging, staged.id), { recursive: true, force: true });
    return { ...staged, name, mime: mimeOf(name), path: join(dir, name) };
  }

  removeFile(a: Attachment) {
    // Only ever a file of ours.
    if (a.path.startsWith(this.root + "/")) rmSync(a.path, { force: true });
  }

  removeCard(cardId: string) {
    if (CARD_DIR.test(cardId)) rmSync(this.cardDir(cardId), { recursive: true, force: true });
  }

  /** Staged files a day old (their dialog is long gone) and folders of cards that aren't there. */
  sweep(cards: Set<string>, now = Date.now()) {
    if (existsSync(this.staging)) for (const id of readdirSync(this.staging)) {
      const p = join(this.staging, id);
      if (now - statSync(p).mtimeMs > STAGED_FOR) rmSync(p, { recursive: true, force: true });
    }
    if (existsSync(this.root)) for (const d of readdirSync(this.root)) {
      if (CARD_DIR.test(d) && !cards.has(d)) rmSync(join(this.root, d), { recursive: true, force: true });
    }
  }
}
