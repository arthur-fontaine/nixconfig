# web for Pi

Three tools that let the model look things up on the live web:

| Tool | What it does |
| --- | --- |
| `web_search` | Searches through [TinySearch](https://www.tinyfish.ai/search) and returns ranked results: title, URL, snippet, date. Takes domain filters, a freshness window, news or papers, a language and a page. |
| `web_fetch` | Reads up to 10 pages through TinyFish's Fetch API, as Markdown. It can also list each page's image URLs and links. Long pages are cut at 40,000 characters, and the model is told so. |
| `view_image` | Downloads an image from a URL and returns it to the model as an image, so it can see it. PNG, JPEG, GIF and WebP. Images over 3.5 MB go through macOS's `sips` and become a JPEG at most 1568 px wide. |

A typical loop: `web_search` for a page, `web_fetch` with `images: true`
to get its picture URLs, then `view_image` on the ones worth seeing.

## API key

Search is free up to 12,000 requests a day; Fetch uses the same key. Create
one at <https://agent.tinyfish.ai/api-keys> and add it to `~/.config/.env`,
which stays out of this repo:

```sh
TINYFISH_API_KEY=…
```

The shell exports that file (`zshrc.d/902_dotenv.sh`). A Pi started some
other way reads the file itself.

## Tests

```sh
node --test 'tests/*.test.ts'   # Node 24 runs the TypeScript directly; no Pi or network needed
```
