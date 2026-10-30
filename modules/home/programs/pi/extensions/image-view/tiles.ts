import { pathToFileURL } from "node:url";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { type Cells, fitRow, GAP, type Size, TILE_CHROME_COLUMNS } from "./layout.ts";

/** A thumbnail: a pasted image (`#n`) or one a tool showed. `path` is null when its file can't be found. */
export type Tile = { id: string; label: string; alt: string; path: string | null; size: Size | null };

/** A picture's rows, each `columns` cells wide: undefined while it's being made, null when it can't be. */
export type Paint = (path: string, cells: Cells) => string[] | null | undefined;

export interface TileRowOptions {
	/** Null draws the labels alone, under a picture Pi draws itself. */
	paint: Paint | null;
	open: (path: string) => void;
	maxRows: number;
	indent?: number;
	/** Whether to make pictures and labels OSC 8 links too, for when the terminal gets the clicks. */
	links: () => boolean;
	dim: (text: string) => string;
	truncate?: (text: string, width: number) => string;
	invalidate?: () => void;
}

type Hit = { x0: number; x1: number; y0: number; y1: number; path: string };

function plainTruncate(text: string, width: number): string {
	const chars = [...text];
	return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function center(text: string, width: number, textWidth: number): string {
	const left = Math.floor((width - textWidth) / 2);
	return " ".repeat(left) + text + " ".repeat(width - textWidth - left);
}

/**
 * One row of bordered tiles, each a picture over its label; wraps onto more rows
 * when even the smallest tiles don't fit. A click anywhere on a tile with a
 * file opens it, in fullscreen mode where Pi routes mouse events to components.
 */
export class TileRow implements Component {
	private hits: Hit[] = [];
	private readonly tiles: readonly Tile[];
	private readonly options: TileRowOptions;

	constructor(tiles: readonly Tile[], options: TileRowOptions) {
		this.tiles = tiles;
		this.options = options;
	}

	invalidate(): void {
		this.options.invalidate?.();
	}

	render(width: number): string[] {
		this.hits = [];
		if (this.tiles.length === 0) return [];
		const indent = this.options.indent ?? 0;
		const body = Math.max(1, width - indent);
		return this.options.paint === null ? this.renderLabels(body, indent) : this.renderTiles(body, indent);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const hit = this.hits.find((h) => event.x >= h.x0 && event.x < h.x1 && event.y >= h.y0 && event.y < h.y1);
		if (!hit) return undefined;
		this.options.open(hit.path);
		return { handled: true };
	}

	private truncate(text: string, width: number): string {
		return (this.options.truncate ?? plainTruncate)(text, width);
	}

	private link(text: string, tile: Tile): string {
		if (tile.path === null || !this.options.links()) return text;
		// The id makes terminals treat every row of one picture as a single link.
		return `\x1b]8;id=image-view-${tile.id};${pathToFileURL(tile.path).href}\x1b\\${text}\x1b]8;;\x1b\\`;
	}

	private renderLabels(body: number, indent: number): string[] {
		const lines: string[] = [];
		let line = "";
		let used = 0;
		for (const tile of this.tiles) {
			const label = this.truncate(tile.label, body);
			const labelWidth = Math.min([...tile.label].length, body);
			if (used > 0 && used + 2 + labelWidth > body) {
				lines.push(" ".repeat(indent) + line);
				line = "";
				used = 0;
			}
			if (used > 0) {
				line += "  ";
				used += 2;
			}
			if (tile.path !== null) {
				this.hits.push({ x0: indent + used, x1: indent + used + labelWidth, y0: lines.length, y1: lines.length + 1, path: tile.path });
			}
			line += this.link(this.options.dim(label), tile);
			used += labelWidth;
		}
		lines.push(" ".repeat(indent) + line);
		return lines;
	}

	private renderTiles(body: number, indent: number): string[] {
		const cells = fitRow(
			this.tiles.map((tile) => tile.size),
			this.options.maxRows,
			body,
		);
		const groups: number[][] = [];
		let used = 0;
		for (let i = 0; i < this.tiles.length; i++) {
			const tileWidth = cells[i]!.columns + TILE_CHROME_COLUMNS;
			const group = groups.at(-1);
			if (group && used + GAP + tileWidth <= body) {
				group.push(i);
				used += GAP + tileWidth;
			} else {
				groups.push([i]);
				used = tileWidth;
			}
		}

		const lines: string[] = [];
		for (const group of groups) {
			const pictureRows = Math.max(...group.map((i) => cells[i]!.rows));
			const columns: string[][] = [];
			let x = indent;
			for (const i of group) {
				const tile = this.tiles[i]!;
				const fit = cells[i]!;
				columns.push(this.tileLines(tile, fit, pictureRows));
				if (tile.path !== null) {
					this.hits.push({ x0: x, x1: x + fit.columns + TILE_CHROME_COLUMNS, y0: lines.length, y1: lines.length + pictureRows + 3, path: tile.path });
				}
				x += fit.columns + TILE_CHROME_COLUMNS + GAP;
			}
			for (let row = 0; row < pictureRows + 3; row++) {
				lines.push(" ".repeat(indent) + columns.map((tileLines) => tileLines[row]!).join(" ".repeat(GAP)));
			}
		}
		return lines;
	}

	private tileLines(tile: Tile, { columns, rows }: Cells, pictureRows: number): string[] {
		const { dim } = this.options;
		const side = dim("│");
		const blank = " ".repeat(columns);
		const textRows = (text: string): string[] => {
			const shown = this.truncate(text, columns);
			const middle = Math.floor((rows - 1) / 2);
			return Array.from({ length: rows }, (_, row) => (row === middle ? center(dim(shown), columns, Math.min([...text].length, columns)) : blank));
		};
		let picture: string[];
		if (tile.path === null) {
			picture = textRows("no preview");
		} else {
			const painted = this.options.paint!(tile.path, { columns, rows });
			picture = painted ? painted.map((row) => this.link(row, tile)) : textRows(painted === null ? tile.alt : "…");
		}
		const label = center(this.link(dim(this.truncate(tile.label, columns)), tile), columns, Math.min([...tile.label].length, columns));
		return [
			dim(`╭${"─".repeat(columns)}╮`),
			...picture.map((row) => side + row + side),
			...Array.from({ length: pictureRows - rows }, () => side + blank + side),
			side + label + side,
			dim(`╰${"─".repeat(columns)}╯`),
		];
	}
}
