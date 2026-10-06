import { expect, mock, test } from 'claude-code/testing'

import { halfBlockCells, parseBmp } from '../hooks/halfblock'

// Written by `sips -s format bmp`: 32-bit BI_BITFIELDS, top-down.
// 5×3, pixel (x, y) = rgb(50x, 100y, 128).
const GRADIENT =
  'Qk3GAAAAAAAAAIoAAAB8AAAABQAAAP3///8BACAAAwAAADwAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA/4AAMv+AAGT/gACW/4AAyP+AZAD/gGQy/4BkZP+AZJb/gGTI/4DIAP+AyDL/gMhk/4DIlv+AyMj/'
// 2×4: red green / blue white / rgb(10,20,30) transparent / rgb(200,100,50) rgb(1,2,3).
const TILE =
  'Qk2qAAAAAAAAAIoAAAB8AAAAAgAAAPz///8BACAAAwAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//wD/AP//AAD//////x4UCv8AAAAAMmTI/wMCAf8='

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function words(cells: string): number[] {
  const bytes = Uint8Array.from(atob(cells), char => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true))
}

test('a sips BMP parses to top-down RGBA', () => {
  const bitmap = parseBmp(GRADIENT)
  expect(bitmap?.width).toBe(5)
  expect(bitmap?.height).toBe(3)
  const at = (x: number, y: number) => Array.from(bitmap!.rgba.slice((y * 5 + x) * 4, (y * 5 + x) * 4 + 4))
  expect(at(0, 0)).toEqual([0, 0, 128, 255])
  expect(at(4, 0)).toEqual([200, 0, 128, 255])
  expect(at(2, 2)).toEqual([100, 200, 128, 255])
})

test('a bottom-up 24-bit BMP parses too', () => {
  // 1×2, rows padded to 4 bytes, bottom row first: blue at the bottom, red on top.
  const bytes = new Uint8Array(54 + 8)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, 1, true)
  view.setInt32(22, 2, true)
  view.setUint16(28, 24, true)
  bytes.set([255, 0, 0, 0, 0, 0, 255, 0], 54)
  const bitmap = parseBmp(base64Of(bytes))
  expect(Array.from(bitmap!.rgba)).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
})

test('not a BMP, or one this parser does not read, is null', () => {
  expect(parseBmp(btoa('\x89PNG\r\n\x1a\n not a bitmap at all, just a png header....'))).toBeNull()
})

test('each cell is an upper half block over two pixels', () => {
  const cells = halfBlockCells(parseBmp(TILE)!, 2, 2)
  expect(words(cells!)).toEqual([
    0x2580, 0xff0000, 0x0000ff,
    0x2580, 0x00ff00, 0xffffff,
    0x2580, 0x0a141e, 0xc86432,
    // The transparent pixel takes the terminal's default color.
    0x2580, 0x01000000, 0x010203,
  ])
  // A bitmap that isn't the tile's size is refused rather than drawn skewed.
  expect(halfBlockCells(parseBmp(TILE)!, 2, 3)).toBeNull()
})

const BAND = {
  plugin: 'image-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// A 24-bit bottom-up BMP of one color, rgb(0x33, 0x66, 0x99).
function solidBmp(width: number, height: number): string {
  const stride = Math.ceil((width * 3) / 4) * 4
  const bytes = new Uint8Array(54 + stride * height)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(28, 24, true)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set([0x99, 0x66, 0x33], 54 + y * stride + x * 3)
  return base64Of(bytes)
}

const DIR = '/tmp/claude-501/-work/sess-1/images'

// A pasted square PNG; `term` is the session's TERM_PROGRAM, `env` any other variables set.
function paste(on: any, term: string, hasHelper = false, env: Record<string, string> = {}) {
  const runs: string[][] = []
  const clock = mock.clock(on)
  const draft = 'see [Image #1]'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($: any, e: any) => ({
    value: e.name === 'TERM_PROGRAM' ? term : e.name === 'CLAUDE_CODE_TMPDIR' ? '/tmp/claude-501' : env[e.name],
  }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', ($: any, e: any) => ({
    value: e.path === DIR || e.path === `${DIR}/1.png` || (hasHelper && e.path.endsWith('/bin/quicklook')),
  }))
  on('fs.read', ($: any, e: any) => {
    const size = /(\d+)x(\d+)\.bmp$/.exec(e.path)
    if (size) return { value: { base64: solidBmp(Number(size[1]), Number(size[2]) * 2) } }
    // A square PNG's header.
    const head = new Uint8Array(33)
    head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(head.buffer).setUint32(16, 500)
    new DataView(head.buffer).setUint32(20, 500)
    return { value: { base64: base64Of(head) } }
  })
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[0] === 'mktemp' ? '/tmp/thumbs\n' : '', stderr: '' } }
  })
  const spawns: string[][] = []
  on('process.spawn', async function* ($: any, e: any) {
    spawns.push(e.argv)
    return { code: 0, signal: null }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  return { clock, runs, spawns }
}

test('in Zed a tile is a half-block Raster scaled by sips', async ($, on) => {
  const { clock, runs } = paste(on, 'zed')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  // The first drawing asks for the tile and shows a placeholder; the poll converts it.
  const first = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await first.find({ type: 'Image' })).toBeUndefined()
  expect(await first.find({ type: 'Text', text: '…' })).toBeDefined()
  await first.unmount()
  await clock.advance(200)

  // A square is 12 columns by 6 rows, so sips scales to 12×12 pixels (height first).
  const sips = runs.filter(argv => argv[0] === '/usr/bin/sips')
  expect(sips).toEqual([['/usr/bin/sips', '-s', 'format', 'bmp', '-z', '12', '12', `${DIR}/1.png`, '--out', '/tmp/thumbs/1-12x6.bmp']])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props).toMatchObject({ key: 'image-1', columns: 12, rows: 6 })
  expect(words(raster!.props.cells).slice(0, 3)).toEqual([0x2580, 0x336699, 0x336699])
  await ui.unmount()

  // Drawn again at the same size, it isn't converted again.
  await clock.advance(400)
  expect(runs.filter(argv => argv[0] === '/usr/bin/sips').length).toBe(1)
})

test('outside Zed the tile stays a kitty-protocol Image and sips never runs', async ($, on) => {
  const { clock, runs } = paste(on, 'ghostty')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: `${DIR}/1.png`, format: 'png' } })
  await ui.unmount()
  await clock.advance(200)
  expect(runs.some(argv => argv[0] === '/usr/bin/sips')).toBe(false)
})

test('a background session gets half blocks too, whatever terminal attaches', async ($, on) => {
  const { clock } = paste(on, '', false, { CLAUDE_CODE_SESSION_KIND: 'bg' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  await (await $.ui.mount({ ...BAND, surface: 'terminal' })).unmount()
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
})

test('a background session that forces terminal images keeps the Image', async ($, on) => {
  const { clock } = paste(on, 'ghostty', false, { CLAUDE_CODE_SESSION_KIND: 'bg', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test("pressing a tile's label opens it in Quick Look, through qlmanage without the helper", async ($, on) => {
  const { clock, spawns } = paste(on, 'ghostty')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'open-1' })
  await ui.unmount()
  expect(spawns).toEqual([['/usr/bin/qlmanage', '-p', `${DIR}/1.png`]])
})

test('the bundled helper is preferred over qlmanage', async ($, on) => {
  const { clock, spawns } = paste(on, 'ghostty', true)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'open-1' })
  await ui.unmount()
  expect(spawns.length).toBe(1)
  expect(spawns[0][0]).toMatch(/\/bin\/quicklook$/)
  expect(spawns[0].slice(1)).toEqual([`${DIR}/1.png`])
})
