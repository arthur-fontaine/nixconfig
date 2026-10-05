import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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

// Zed's terminal has no graphics protocol, so an Image there only shows its alt.
// Tiles are drawn as half-block Rasters instead, from a BMP `sips` scales to the
// tile. The render hook can't run sips, so it records the tiles it wants and
// the poll converts them.
let isZed = false
let thumbDir: string | undefined
type Wanted = Cells & { n: number; path: string }
let wanted: Wanted[] = []
// Raster cells by thumbKey; null when the conversion failed.
const thumbs = new Map<string, string | null>()

function thumbKey({ path, columns, rows }: Wanted): string {
  return `${path}:${columns}x${rows}`
}

async function thumbnail($: EngineInterface, tile: Wanted): Promise<string | null> {
  thumbDir ??= (await $.process.run(['mktemp', '-d'])).stdout.trim()
  const out = `${thumbDir}/${tile.n}-${tile.columns}x${tile.rows}.bmp`
  // -z takes the height first.
  const args = ['-s', 'format', 'bmp', '-z', String(tile.rows * 2), String(tile.columns), tile.path, '--out', out]
  const { exitCode } = await $.process.run(['/usr/bin/sips', ...args])
  if (exitCode !== 0) return null
  const bitmap = parseBmp((await $.fs.read(out, { as: 'bytes' })).base64)
  return bitmap === null ? null : halfBlockCells(bitmap, tile.columns, tile.rows)
}

async function convertWanted($: EngineInterface) {
  const keys = new Set(wanted.map(thumbKey))
  for (const key of thumbs.keys()) if (!keys.has(key)) thumbs.delete(key)
  let isNew = false
  for (const tile of wanted) {
    const key = thumbKey(tile)
    if (thumbs.has(key)) continue
    thumbs.set(key, await thumbnail($, tile).catch(() => null))
    isNew = true
  }
  if (isNew) $.ui.invalidate('ui.render')
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

async function check($: EngineInterface) {
  if (isChecking) return
  isChecking = true
  try {
    await show($, (await $.prompt.read()).text)
    if (isZed) await convertWanted($)
  } finally {
    isChecking = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isZed = (await $.env.get('TERM_PROGRAM')) === 'zed'
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) {
      wanted = []
      return next(e)
    }

    const { Box, Image, Raster, Text } = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    const below = await next(e)

    if (isZed) {
      wanted = list.flatMap((image, i) => (image.path === null ? [] : [{ n: image.n, path: image.path, ...(cells[i] ?? { columns: 4, rows: 1 }) }]))
    }
    const picture = (image: PastedImage & { path: string }, columns: number, rows: number) => {
      if (!isZed) {
        return (
          <Image
            key={`image-${image.n}`}
            source={{ file: image.path, format: 'png' }}
            columns={columns}
            rows={rows}
            alt={`[Image #${image.n}]`}
          />
        )
      }
      const thumb = thumbs.get(thumbKey({ n: image.n, path: image.path, columns, rows }))
      if (thumb) return <Raster key={`image-${image.n}`} columns={columns} rows={rows} cells={thumb} />
      return (
        <Box width={columns} height={rows} alignItems="center" justifyContent="center">
          <Text dimColor wrap="truncate">{thumb === null ? `[Image #${image.n}]` : '…'}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            return (
              <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {image.path === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : (
                  picture({ ...image, path: image.path }, columns, rows)
                )}
                <Text dimColor>#{image.n}</Text>
              </Box>
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
