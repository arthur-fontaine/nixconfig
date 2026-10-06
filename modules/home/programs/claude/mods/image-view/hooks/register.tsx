import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiRenderEvent } from 'claude-code'

import type { PastedImage } from '../types'
import { halfBlockCells, parseBmp } from './halfblock'
import { fitRow, imageNumbers, pngSize } from './layout'
import type { Cells, Size } from './layout'

// Pasting an image raises no prompt.edit (the tag only shows up on the next keystroke),
// so the draft is polled instead.
const POLL_MS = 200

const images = atom({ plugin: 'image-view', key: 'images' } as const, [] as PastedImage[])

let tmpRoot: string | undefined
let found: { sessionId: string; dir: string } | undefined
// The image numbers last drawn, so an unchanged draft doesn't rewrite state; undefined
// while a drawn image's file is still missing, so the next poll looks again.
let shownKey: string | undefined
let isChecking = false
const sizes = new Map<string, Size | null>()

// A thumbnail: a pasted image (`#n`) or an image Claude read. `id` keys its
// Image and its label's Button within one drawing.
type Tile = { id: string; label: string; alt: string; path: string | null; size: Size | null }

function pastedTile(image: PastedImage): Tile {
  return { id: String(image.n), label: `#${image.n}`, alt: `[Image #${image.n}]`, path: image.path, size: image.size }
}

// Render hooks can't run processes, so each site records the files it needs
// and the poll makes them with sips:
// - where Image can't draw, a half-block Raster for each tile size, from a BMP
//   scaled to the tile;
// - elsewhere, a PNG copy of a JPEG, GIF or WebP, since Image reads PNG files only.
let isHalfBlock = false
let workDir: string | undefined
let fileCount = 0
type Wanted = Cells & { path: string }
// By render site: the band above the prompt, a sent prompt, a Read result.
const wantedThumbs = new Map<string, Wanted[]>()
const wantedPngs = new Map<string, string[]>()
// Raster cells by thumbKey, and PNG copies by source path; null when sips failed.
const thumbs = new Map<string, string | null>()
const pngs = new Map<string, string | null>()

function thumbKey({ path, columns, rows }: Wanted): string {
  return `${path}:${columns}x${rows}`
}

function isPng(path: string): boolean {
  return /\.png$/i.test(path)
}

async function scratchFile($: EngineInterface, name: string): Promise<string> {
  workDir ??= (await $.process.run(['mktemp', '-d'])).stdout.trim()
  fileCount += 1
  return `${workDir}/${fileCount}-${name}`
}

async function thumbnail($: EngineInterface, tile: Wanted): Promise<string | null> {
  const out = await scratchFile($, `${tile.columns}x${tile.rows}.bmp`)
  // -z takes the height first.
  const args = ['-s', 'format', 'bmp', '-z', String(tile.rows * 2), String(tile.columns), tile.path, '--out', out]
  const { exitCode } = await $.process.run(['/usr/bin/sips', ...args])
  if (exitCode !== 0) return null
  const bitmap = parseBmp((await $.fs.read(out, { as: 'bytes' })).base64)
  return bitmap === null ? null : halfBlockCells(bitmap, tile.columns, tile.rows)
}

async function pngCopy($: EngineInterface, path: string): Promise<string | null> {
  const out = await scratchFile($, 'copy.png')
  const { exitCode } = await $.process.run(['/usr/bin/sips', '-s', 'format', 'png', path, '--out', out])
  return exitCode === 0 ? out : null
}

async function convertWanted($: EngineInterface) {
  let isNew = false
  const tiles = [...wantedThumbs.values()].flat()
  const tileKeys = new Set(tiles.map(thumbKey))
  for (const key of thumbs.keys()) if (!tileKeys.has(key)) thumbs.delete(key)
  for (const tile of tiles) {
    const key = thumbKey(tile)
    if (thumbs.has(key)) continue
    thumbs.set(key, await thumbnail($, tile).catch(() => null))
    isNew = true
  }
  for (const path of new Set([...wantedPngs.values()].flat())) {
    if (pngs.has(path)) continue
    pngs.set(path, await pngCopy($, path).catch(() => null))
    isNew = true
  }
  if (isNew) $.ui.invalidate('ui.render')
}

// Both runs until the Quick Look panel closes, so the previous preview is ended
// before the next one opens. bin/quicklook (quicklook/main.swift, built by
// nixconfig) opens without a Dock icon on the display under the pointer;
// `qlmanage -p` is the fallback when it isn't there.
let preview: ReturnType<EngineInterface['process']['spawn']> | undefined

async function quickLook($: EngineInterface, path: string) {
  void preview?.return(undefined)
  const helper = `${$.plugin.root}/bin/quicklook`
  const argv = (await $.fs.exists(helper)) ? [helper, path] : ['/usr/bin/qlmanage', '-p', path]
  const child = $.process.spawn({ argv })
  preview = child
  void (async () => {
    try {
      for await (const _ of child) {
        // Drained only to keep the child alive until the panel closes.
      }
    } catch {
      // Closed, replaced, or qlmanage missing: nothing to show either way.
    } finally {
      if (preview === child) preview = undefined
    }
  })()
}

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png. The project
// folder is named after a working directory that may since have moved, so find it by the
// session id instead of rebuilding it.
async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found.dir
  if (tmpRoot === undefined) {
    const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
    tmpRoot = fromEnv ?? `/tmp/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  }
  const entries = await $.fs.list(tmpRoot).catch(() => [])
  for (const entry of entries) {
    const dir = `${tmpRoot}/${entry.name}/${sessionId}/images`
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
      found = { sessionId, dir }
      return dir
    }
  }
  return undefined
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const path = `${dir}/${n}.png`
  if (dir === undefined || !(await $.fs.exists(path))) return { n, path: null, size: null }
  if (!sizes.has(path)) {
    const head = await $.fs.read(path, { as: 'bytes' }).then(
      ({ base64 }) => pngSize(base64),
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    if (head === null) return { n, path: null, size: null }
    sizes.set(path, head ?? null)
  }
  return { n, path, size: sizes.get(path) ?? null }
}

async function show($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const dir = numbers.length > 0 ? await imagesDir($) : undefined
  const list: PastedImage[] = []
  for (const n of numbers) list.push(await describe($, dir, n))
  shownKey = list.every(image => image.path !== null) ? key : undefined
  await update($, images, () => list)
}

// A sent prompt's images, by message id, once every tag has its file.
const messageImages = new Map<string, PastedImage[]>()

async function imagesOf($: EngineInterface, messageId: string, text: string): Promise<PastedImage[]> {
  const cached = messageImages.get(messageId)
  if (cached) return cached
  const numbers = imageNumbers(text)
  if (numbers.length === 0) return []
  const dir = await imagesDir($)
  const list: PastedImage[] = []
  for (const n of numbers) list.push(await describe($, dir, n))
  if (list.every(image => image.path !== null)) messageImages.set(messageId, list)
  return list
}

// The file each Read call opened, by tool_use_id: a Read result carries the
// image but not its path. Filled as calls run, and from their rows on a resume.
const readPaths = new Map<string, string>()

type ReadImageOutput = {
  type: 'image'
  file: { dimensions?: { originalWidth?: number; originalHeight?: number; displayWidth?: number; displayHeight?: number } }
}

function isReadImage(output: unknown): output is ReadImageOutput {
  return typeof output === 'object' && output !== null && (output as { type?: unknown }).type === 'image'
}

function readSize(output: ReadImageOutput): Size | null {
  const d = output.file?.dimensions
  const width = d?.originalWidth ?? d?.displayWidth
  const height = d?.originalHeight ?? d?.displayHeight
  return width && height ? { width, height } : null
}

function fileTile(id: string, path: string, size: Size | null): Tile {
  const name = path.split('/').pop() ?? path
  return { id, label: name, alt: `[${name}]`, path, size }
}

// What SendUserFile and SendUserMessage resolve each attachment to.
type Attachment = { path?: unknown; isImage?: unknown; scaled?: { original_width?: number; original_height?: number } }

type ContentBlock = { type?: unknown; text?: unknown; source?: { media_type?: unknown; data?: unknown } }

const SAVED_IMAGE = /^\[Image: source: (\/.+)\]$/

// An MCP result (an argent screenshot, say) is a list of content blocks, bare or
// under `content`. Claude Code saves each image block to a file and names it in
// the text block right after.
function contentImages(output: unknown, prefix: string): Tile[] {
  const blocks = Array.isArray(output) ? output : (output as { content?: unknown } | null)?.content
  if (!Array.isArray(blocks)) return []
  return (blocks as ContentBlock[]).flatMap((block, i) => {
    if (block?.type !== 'image') return []
    const next = blocks[i + 1] as ContentBlock | undefined
    const path = next?.type === 'text' && typeof next.text === 'string' ? SAVED_IMAGE.exec(next.text)?.[1] : undefined
    if (path === undefined) return []
    const { media_type: type, data } = block.source ?? {}
    const size = type === 'image/png' && typeof data === 'string' ? pngSize(data) : null
    return [fileTile(`${prefix}-${i}`, path, size)]
  })
}

// The images a tool call showed: the file Read loaded, the ones Claude sent
// with SendUserFile or SendUserMessage, or an MCP tool's image blocks. `path`
// is Read's, which its result lacks.
function toolImages(tool: string, output: unknown, path: string | undefined, prefix: string): Tile[] {
  if (tool === 'Read') {
    return path !== undefined && isReadImage(output) ? [fileTile(prefix, path, readSize(output))] : []
  }
  if (tool.startsWith('mcp__')) return contentImages(output, prefix)
  if (tool !== 'SendUserFile' && tool !== 'SendUserMessage') return []
  const attachments = (output as { attachments?: unknown } | null)?.attachments
  if (!Array.isArray(attachments)) return []
  return (attachments as Attachment[]).flatMap((attachment, i) => {
    if (attachment.isImage !== true || typeof attachment.path !== 'string' || !attachment.path.startsWith('/')) return []
    const { original_width: width, original_height: height } = attachment.scaled ?? {}
    return [fileTile(`${prefix}-${i}`, attachment.path, width && height ? { width, height } : null)]
  })
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

// One row of tiles, each with its label, which opens the image in Quick Look.
function tileRow($: EngineInterface, ui: Elements, site: string, tiles: Tile[], cells: Cells[]) {
  const { Box, Button, Image, Raster, Text } = ui
  const fit = (i: number) => cells[i] ?? { columns: 4, rows: 1 }
  const drawn = tiles.flatMap((tile, i) => (tile.path === null ? [] : [{ path: tile.path, ...fit(i) }]))
  if (isHalfBlock) wantedThumbs.set(site, drawn)
  else wantedPngs.set(site, drawn.map(tile => tile.path).filter(path => !isPng(path)))

  const placeholder = (text: string, columns: number, rows: number) => (
    <Box width={columns} height={rows} alignItems="center" justifyContent="center">
      <Text dimColor wrap="truncate">{text}</Text>
    </Box>
  )

  const picture = (tile: Tile & { path: string }, columns: number, rows: number) => {
    if (isHalfBlock) {
      const thumb = thumbs.get(thumbKey({ path: tile.path, columns, rows }))
      if (thumb) return <Raster key={`image-${tile.id}`} columns={columns} rows={rows} cells={thumb} />
      return placeholder(thumb === null ? tile.alt : '…', columns, rows)
    }
    const file = isPng(tile.path) ? tile.path : pngs.get(tile.path)
    if (file) {
      return <Image key={`image-${tile.id}`} source={{ file, format: 'png' }} columns={columns} rows={rows} alt={tile.alt} />
    }
    return placeholder(file === null ? tile.alt : '…', columns, rows)
  }

  return (
    <Box flexDirection="row" columnGap={1}>
      {tiles.map((tile, i) => {
        const { columns, rows } = fit(i)
        return (
          <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
            {tile.path === null ? placeholder('no preview', columns, rows) : picture({ ...tile, path: tile.path }, columns, rows)}
            {tile.path === null ? (
              <Text dimColor>{tile.label}</Text>
            ) : (
              // An Image or Raster can't take a press, so the label under it opens the preview.
              <Button
                key={`open-${tile.id}`}
                plain
                dimColor
                label={tile.label}
                onPress={() => void quickLook($, tile.path!)}
              />
            )}
          </Box>
        )
      })}
    </Box>
  )
}

// Transcript tiles: up to 6 picture rows plus border and label, past the row's gutter.
const TRANSCRIPT_MAX_ROWS = 9
const MESSAGE_INDENT = 2
const RESULT_INDENT = 5

function transcriptColumns(e: { viewport?: { columns: number } }, indent: number): number {
  return (e.viewport?.columns ?? 80) - indent * 2
}

function isOwnPrompt(e: UiRenderEvent & { component: 'UserMessage' }): boolean {
  const { origin, from } = e.props
  return origin.kind === 'composer' || (origin.kind === 'unclassified' && from === undefined)
}

async function check($: EngineInterface) {
  if (isChecking) return
  isChecking = true
  try {
    await show($, (await $.prompt.read()).text)
    await convertWanted($)
  } finally {
    isChecking = false
  }
}

// Image draws nothing in Zed's terminal, which has no graphics protocol, nor in
// a background session (`claude attach`, agent view), where Claude Code turns
// terminal images off unless CLAUDE_CODE_FORCE_TERMINAL_IMAGES is set. A
// background session can't tell which terminal attaches, so it gets half blocks.
async function needsHalfBlocks($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('TERM_PROGRAM')) === 'zed') return true
  if ((await $.env.get('CLAUDE_CODE_SESSION_KIND')) !== 'bg') return false
  const forced = await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')
  return forced === undefined || forced === '' || forced === '0' || forced === 'false'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isHalfBlock = await needsHalfBlocks($)
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    readPaths.set(e.tool_use_id, e.file_path)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) {
      wantedThumbs.delete('above-prompt')
      wantedPngs.delete('above-prompt')
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    const below = await next(e)
    return (
      <ui.Box flexDirection="column">
        {tileRow($, ui, 'above-prompt', list.map(pastedTile), cells)}
        {below}
      </ui.Box>
    )
  })

  // The same tiles under a sent prompt, whose text keeps its [Image #n] tags.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !isOwnPrompt(e)) return next(e)
    const list = await imagesOf($, e.requestId, e.props.text)
    if (list.length === 0) return next(e)

    const ui = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), TRANSCRIPT_MAX_ROWS, transcriptColumns(e, MESSAGE_INDENT))
    const message = await next(e)
    return (
      <ui.Box flexDirection="column">
        {message}
        <ui.Box marginLeft={MESSAGE_INDENT}>{tileRow($, ui, `message-${e.requestId}`, list.map(pastedTile), cells)}</ui.Box>
      </ui.Box>
    )
  })

  // A resumed session ran its Read calls before this module loaded.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const input = e.props.input as { file_path?: unknown } | null
    if (e.props.tool === 'Read' && typeof input?.file_path === 'string') readPaths.set(e.props.tool_use_id, input.file_path)
    return next(e)
  })

  // And under a tool result that showed images: a Read that loaded one
  // ("Read image (42KB)"), files Claude sent ("› [image] shot.png"), or an MCP
  // tool's screenshots.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored) return next(e)
    const tiles = toolImages(e.props.tool, e.props.output, readPaths.get(e.props.tool_use_id), 'tool')
    if (tiles.length === 0) return next(e)

    const ui = $.ui.resolve(e)
    const cells = fitRow(tiles.map(tile => tile.size), TRANSCRIPT_MAX_ROWS, transcriptColumns(e, RESULT_INDENT))
    const result = await next(e)
    return (
      <ui.Box flexDirection="column">
        {result}
        <ui.Box marginLeft={RESULT_INDENT}>{tileRow($, ui, `tool-${e.props.tool_use_id}`, tiles, cells)}</ui.Box>
      </ui.Box>
    )
  })

  // Runs of reads fold into one line ("Read 3 files"), with no result rows.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const tiles = e.props.calls.flatMap((call, i) => {
      if (call.isErrored) return []
      const path = (call.input as { file_path?: unknown } | null)?.file_path
      return toolImages(call.tool, call.output, typeof path === 'string' ? path : undefined, `call-${i}`)
    })
    if (tiles.length === 0) return next(e)

    const ui = $.ui.resolve(e)
    const cells = fitRow(tiles.map(tile => tile.size), TRANSCRIPT_MAX_ROWS, transcriptColumns(e, RESULT_INDENT))
    const group = await next(e)
    return (
      <ui.Box flexDirection="column">
        {group}
        <ui.Box marginLeft={RESULT_INDENT}>{tileRow($, ui, `group-${e.requestId}`, tiles, cells)}</ui.Box>
      </ui.Box>
    )
  })
}
