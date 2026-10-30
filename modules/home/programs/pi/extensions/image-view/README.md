# Image View for Pi

A port of the Claude Code mod in
[`../../../claude/mods/image-view`](../../../claude/mods/image-view) (a copy of
[jarrodwatts/claude-image-view](https://github.com/jarrodwatts/claude-image-view)):
thumbnails of the images in a draft, under each sent prompt and under tool
results, that open in macOS Quick Look when clicked. Unlike the mod, where only
a tile's label took a click, the picture is clickable too.

It works alongside [pi-image-view](https://www.npmjs.com/package/pi-image-view)
(0.5.0), which owns pasting and the `[Image #n]` markers (see
[With pi-image-view](#with-pi-image-view)).

```
╭────────────────────╮ ╭────────────╮
│▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│ │▀▀▀▀▀▀▀▀▀▀▀▀│
│▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│ │▀▀▀▀▀▀▀▀▀▀▀▀│
│         #1         │ │     #2     │
╰────────────────────╯ ╰────────────╯
```

## From the mod to Pi

| The Claude Code mod | In Pi | Same? |
|---|---|---|
| A row of tiles above the prompt for the draft's `[Image #n]` tags, polled every 200 ms since a paste raises no edit event | A widget above the editor, polled every 200 ms. The markers are pi-image-view's; the file behind each comes from the options it hangs on its editor (`Symbol.for("pi-image-view.draft-link-options")`). Drawn only where pi-image-view shows no gallery of its own, i.e. outside Kitty-protocol terminals (Zed) | Not in Ghostty: pi-image-view's gallery is there instead, and its pictures don't take clicks. Relies on a pi-image-view internal |
| Tiles keep their shape, shrink so the row fits the band, never scroll | Same layout code (`layout.ts`). The band's height is capped at a third of the terminal (at most 6 picture rows), since Pi gives a widget no measure of the room left; a row too wide even at one picture row wraps instead of overflowing | Height cap differs |
| Clears on send or when the tags are deleted | Same | Yes |
| "no preview" when the file can't be found, "…" while a picture is being made, the alt text when it can't be | Same | Yes |
| Tiles under each sent prompt with `[Image #n]` tags | A custom session entry (`image-view`) right after each user message with images, drawn by an entry renderer: Pi's user message is plain Markdown with no room for pictures. It stays out of the model's context and comes back on resume. The files are pi-image-view's blobs (`[[Image #n]](file://…/image-view/blobs/…)` in the message); a message's own image blocks otherwise (a photo sent from the Claude apps through remote-control, say), saved under `$TMPDIR/pi-image-view/` | Sessions recorded before the extension get none. Every user message with images, not only those typed in the composer |
| Tiles under a Read that loaded an image, and under a folded "Read N files" line | Under a `read` result with an image, through `registerToolRenderer`; the tile is the file that was read. Pi doesn't fold reads | Yes |
| Tiles under SendUserFile / SendUserMessage attachments | — | Pi has no such tools |
| Tiles under an MCP tool's image blocks, from the file Claude Code saved each to | Under any tool result with image blocks; the bytes are saved under `$TMPDIR/pi-image-view/` | Yes |
| Kitty-protocol `Image` in Ghostty and kitty | Kitty Unicode placeholders, like pi-image-view's gallery: the picture is text cells to Pi's renderer, so tiles sit side by side, scroll and clip like text, and take clicks. Under tool results, where Pi already draws the picture, only the label is added | Tool results: label only |
| A JPEG, GIF or WebP shown from a PNG copy `sips` makes | Pi's own `resizeImage` and `convertToPng`, scaled to at most 640 px | Different converter |
| Half blocks in Zed (`TERM_PROGRAM=zed`), scaled by `sips` to a BMP | Same code, as ANSI truecolor rows, wherever Pi detects no graphics protocol (Zed included) and in iTerm2. `PI_IMAGE_PROTOCOL=none` forces them | Yes, in more terminals |
| Half blocks in a background session unless `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` | — | Pi has no background sessions |
| Clicking a tile's label opens it in Quick Look through `bin/quicklook`, else `qlmanage -p`, one preview at a time | Clicking anywhere on a tile, picture included. See [Clicking](#clicking) | Better in fullscreen mode, worse in regular mode |
| The label is a Button: inverse and no longer dim under the pointer | The pointer anywhere on a tile shows its label inverse and its border in the theme's `borderAccent`. Fullscreen mode only | Border highlighted too |
| — | A click on any OSC 8 link to a local image (pi-image-view's `[Image #n]` in the editor and in sent prompts, a Markdown link to a picture) opens Quick Look rather than Preview | Fullscreen mode only |
| Draws nothing in the Claude Desktop app, nor while a survey shows | Draws nothing outside Pi's terminal UI (RPC, JSON, print modes), nor when Pi's *Show images* setting is off | — |

## Clicking

Pi 1.4 runs fullscreen by default (`tuiMode`), and then reads the mouse itself
and hands clicks to components. A click anywhere on a tile, picture or label,
opens it in Quick Look, through, in order:

1. `$PI_IMAGE_VIEW_QUICKLOOK`, if it names a file,
2. `bin/quicklook` next to `index.ts` (the mod's helper: no Dock icon, opens on
   the display under the pointer),
3. `/usr/bin/qlmanage -p`.

A new preview ends the previous one, as in the mod.

The pointer over a tile highlights it, like the mod's Button: the label turns
inverse and the border takes the theme's `borderAccent`. Pi passes a component
the pointer moves over it but never says when the pointer left, so the
extension also sees every input sequence Pi's renderer gets (it wraps the
renderer's private `handleTerminalInput`; an `onTerminalInput` listener comes
after the renderer's own mouse handling, which consumes mouse sequences), and
a pointer event no tile claimed clears the highlight. So does a wheel scroll
and the window losing focus. Inside tmux or screen, Pi asks only for motion
while a button is held, so there is no hover there.

In regular mode (`"tuiMode": "regular"`) the terminal keeps the mouse, so each
picture row and label is instead an OSC 8 link to the file (`file://`), which
the terminal opens however it opens links (untested: presumably Cmd-click, and
the default app, Preview, rather than Quick Look). A custom URL scheme would
need a registered handler app. The links are also in the transcript Pi prints
when it leaves fullscreen.

Fullscreen mode doesn't put links on tiles: Pi gives an OSC 8 link under the
pointer priority over a component's click.

Pi opens a clicked OSC 8 link itself in fullscreen mode, with `open`, so in
the default app. The extension replaces the renderer's private `openUrl` with
one that sends `file://` links to an image (png, jpg, gif, webp, heic, avif,
bmp, tiff) that exists to the same Quick Look command, and every other link to
Pi's `openUrl` unchanged. Each renderer is wrapped once (a mode switch makes a
new one), and a reload only swaps what the wrapper calls.

What was checked, by driving Pi in a pseudo-terminal (`TERM_PROGRAM=zed` and
`ghostty`): the escape sequences of every case above, and that a click on a
picture or label reaches the Quick Look command in fullscreen mode. With
`TERM_PROGRAM=zed` and pi-image-view loaded: that the pointer highlights tiles
in the draft band, under a sent prompt and under a `read` result, that leaving
them clears it, and that a click on a draft's or a sent prompt's `[Image #n]`
or a Markdown link to a picture reaches Quick Look while a web link still
reaches `open`. Not checked: how Ghostty draws the Unicode placeholders, and whether they survive
Pi clearing its own Kitty images (`d=a` when its images move; after a resize,
where Pi clears them all, the tiles upload again). pi-image-view's gallery
relies on the same.

## With pi-image-view

pi-image-view turns pasted or dropped images into `[Image #n]` markers, stores
the model image under `~/.pi/agent/image-view/blobs/`, shows a thumbnail gallery
above the editor in Kitty-protocol terminals, links the markers in the editor
and in sent prompts, strips the links from model requests, upgrades screenshot
tool results, and adds `/pi-image-view`.

This extension changes none of that, except that in fullscreen mode a click on
those links opens Quick Look rather than Preview (see [Clicking](#clicking)):
it reads the markers and the blobs, adds no model context, registers no
Markdown transformer, keeps its own widget key (`image-view-tiles`), and draws
no draft tiles where pi-image-view's gallery shows. Load order doesn't matter.

Without pi-image-view there are no draft tiles (Pi pastes a file path, not a
marker); tiles under sent prompts and tool results still work.

## What it writes

- Each half-block tile is scaled by `/usr/bin/sips` into a BMP in a `mktemp`
  folder, read back and deleted; the folder goes when the session ends.
- Images that only exist as bytes (MCP results, photos from the apps) are saved
  once under `$TMPDIR/pi-image-view/<sha256>.<ext>`, for `sips` and Quick Look.
- One `image-view` custom entry per sent prompt with images, in the session file.

## Tests

```bash
node --test tests/*.test.ts
```

Needs Node 22.18 or later (type stripping); the tests import no Pi package.
They cover the layout, BMP and half-block code ported from the mod's tests, the
tile row (borders, wrapping, placeholders, click targets, hover, links), Kitty
placeholders, where images come from, the Quick Look command, which links go
to it, and the wrapping of Pi's renderer. The mod's tests that mount Claude
Code UI have no Pi harness; the same behaviors were checked by driving Pi in a
pseudo-terminal.
