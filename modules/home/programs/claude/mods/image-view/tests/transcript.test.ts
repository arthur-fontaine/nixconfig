import { expect, mock, test } from 'claude-code/testing'

const DIR = '/tmp/claude-501/-work/sess-1/images'

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function pngHead(width: number, height: number): string {
  const head = new Uint8Array(33)
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(head.buffer).setUint32(16, width)
  new DataView(head.buffer).setUint32(20, height)
  return base64Of(head)
}

function stubs(on: any) {
  const runs: string[][] = []
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'TERM_PROGRAM' ? 'ghostty' : '/tmp/claude-501' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', ($: any, e: any) => ({ value: e.path === DIR || e.path === `${DIR}/1.png` }))
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[0] === 'mktemp' ? '/tmp/work\n' : '', stderr: '' } }
  })
  on('ui.render', ($: any, e: any) => ({ type: 'Text', props: {}, children: [`engine ${e.component}`] }))
  return { clock, runs }
}

const MESSAGE = {
  plugin: 'image-view',
  component: 'UserMessage',
  requestId: 'msg-1',
  surface: 'terminal',
  viewport: { columns: 100, rows: 40 },
  props: { text: 'why is [Image #1] off', origin: { kind: 'composer' }, isExpanded: true },
} as const

test("a sent prompt keeps its images' tiles under the message", async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(MESSAGE)
  expect(await ui.find({ type: 'Text', text: 'engine UserMessage' })).toBeDefined()
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: `${DIR}/1.png`, format: 'png' } })
  expect(await ui.find({ key: 'open-1' })).toBeDefined()
  await ui.unmount()
})

test('a notification row is left as Claude Code draws it', async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...MESSAGE, props: { ...MESSAGE.props, origin: { kind: 'task-notification' } } })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
})

function readSites(path: string) {
  const call = { tool_use_id: 'toolu_1', tool: 'Read' }
  const output = { type: 'image', file: { base64: '', type: 'image/jpeg', originalSize: 1, dimensions: { originalWidth: 600, originalHeight: 300 } } }
  return {
    use: {
      plugin: 'image-view',
      component: 'ToolUse',
      requestId: 'toolu_1',
      surface: 'terminal',
      viewport: { columns: 100, rows: 40 },
      props: { ...call, input: { file_path: path }, isRunning: false, isErrored: false, isInterrupted: false, output },
    } as const,
    result: {
      plugin: 'image-view',
      component: 'ToolResult',
      requestId: 'toolu_1',
      surface: 'terminal',
      viewport: { columns: 100, rows: 40 },
      props: { ...call, output, isErrored: false },
    } as const,
  }
}

test('an image Claude read as a PNG is drawn from its own file', async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const { use, result } = readSites('/work/shots/chart.png')
  await (await $.ui.mount(use)).unmount()
  const ui = await $.ui.mount(result)
  expect(await ui.find({ type: 'Text', text: 'engine ToolResult' })).toBeDefined()
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: '/work/shots/chart.png', format: 'png' } })
  expect(await ui.find({ key: 'open-tool' })).toBeDefined()
  await ui.unmount()
})

test('an image Claude read as a JPEG is shown from a PNG copy sips makes', async ($, on) => {
  const { clock, runs } = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const { use, result } = readSites('/work/shots/photo.jpg')
  await (await $.ui.mount(use)).unmount()

  const first = await $.ui.mount(result)
  expect(await first.find({ type: 'Image' })).toBeUndefined()
  expect(await first.find({ type: 'Text', text: '…' })).toBeDefined()
  await first.unmount()
  await clock.advance(200)

  expect(runs.filter(argv => argv[0] === '/usr/bin/sips')).toEqual([
    ['/usr/bin/sips', '-s', 'format', 'png', '/work/shots/photo.jpg', '--out', '/tmp/work/1-copy.png'],
  ])
  const ui = await $.ui.mount(result)
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: '/tmp/work/1-copy.png', format: 'png' } })
  await ui.unmount()
})

test('a Read result that is not an image is left alone', async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const { use, result } = readSites('/work/notes.md')
  await (await $.ui.mount(use)).unmount()
  const ui = await $.ui.mount({ ...result, props: { ...result.props, output: { type: 'text', file: {} } } })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
})

test('image reads folded into a group line get their tiles too', async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const image = { type: 'image', file: { base64: '', type: 'image/png', originalSize: 1, dimensions: { originalWidth: 400, originalHeight: 400 } } }
  const call = (tool: string, file_path: string, output: unknown) => ({ tool, input: { file_path }, isRunning: false, isErrored: false, isInterrupted: false, output })
  const ui = await $.ui.mount({
    plugin: 'image-view',
    component: 'ToolGroup',
    requestId: 'group-1',
    surface: 'terminal',
    viewport: { columns: 100, rows: 40 },
    props: {
      calls: [call('Read', '/work/a.png', image), call('Read', '/work/notes.md', { type: 'text', file: {} }), call('Read', '/work/b.png', image)],
      isActive: false,
      isExpanded: false,
    },
  })
  expect(await ui.find({ type: 'Text', text: 'engine ToolGroup' })).toBeDefined()
  expect((await ui.find({ key: 'image-call-0' }))?.props).toMatchObject({ source: { file: '/work/a.png' } })
  expect((await ui.find({ key: 'image-call-2' }))?.props).toMatchObject({ source: { file: '/work/b.png' } })
  expect(await ui.find({ key: 'image-call-1' })).toBeUndefined()
  await ui.unmount()
})

test('images Claude sent with SendUserFile get tiles under the result', async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const shot = `${DIR}/1.png`
  const ui = await $.ui.mount({
    plugin: 'image-view',
    component: 'ToolResult',
    requestId: 'toolu_2',
    surface: 'terminal',
    viewport: { columns: 100, rows: 40 },
    props: {
      tool_use_id: 'toolu_2',
      tool: 'SendUserFile',
      isErrored: false,
      output: {
        attachments: [
          { path: shot, size: 319283, isImage: true, scaled: { width: 800, height: 600, original_width: 1600, original_height: 1200 } },
          { path: '/work/report.pdf', size: 1000, isImage: false },
        ],
      },
    },
  })
  expect(await ui.find({ type: 'Text', text: 'engine ToolResult' })).toBeDefined()
  expect((await ui.find({ key: 'image-tool-0' }))?.props).toMatchObject({ source: { file: shot, format: 'png' } })
  expect(await ui.find({ key: 'image-tool-1' })).toBeUndefined()
  expect(await ui.find({ key: 'open-tool-0' })).toBeDefined()
  await ui.unmount()
})

test("an MCP tool's screenshots get tiles under the result, from the files Claude Code saved", async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const shot = '/work/tool-results/mcp-argent-blob-1.png'
  const ui = await $.ui.mount({
    plugin: 'image-view',
    component: 'ToolResult',
    requestId: 'toolu_3',
    surface: 'terminal',
    viewport: { columns: 100, rows: 40 },
    props: {
      tool_use_id: 'toolu_3',
      tool: 'mcp__argent__gesture-tap',
      isErrored: false,
      output: [
        { type: 'text', text: '{ "tapped": true }' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngHead(300, 650) } },
        { type: 'text', text: `[Image: source: ${shot}]` },
        { type: 'text', text: 'Saved: /var/folders/x/simserver/media/1.png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngHead(300, 650) } },
      ],
    },
  })
  expect(await ui.find({ type: 'Text', text: 'engine ToolResult' })).toBeDefined()
  expect((await ui.find({ key: 'image-tool-1' }))?.props).toMatchObject({ source: { file: shot, format: 'png' } })
  expect(await ui.find({ key: 'open-tool-1' })).toBeDefined()
  // An image block with no saved file has no path to draw from.
  expect(await ui.find({ key: 'image-tool-4' })).toBeUndefined()
  await ui.unmount()
})
