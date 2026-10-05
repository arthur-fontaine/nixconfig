// cache-timer
//
// Adds `cache 59:49` to the mode labels in the prompt footer: the time left
// before the session's prompt cache expires. Once it hits zero the label reads
// `cache cold`, meaning the next message re-sends the whole context at full
// price.
//
// The clock restarts on every main-thread request, and on every keep-alive
// ping cache-warmer sends. Pings are read from cache-warmer's state rather
// than by hooking `model.fork`, which would only see them if this mod happened
// to run before cache-warmer.

let ttlMs = 60 * 60_000
let touchedAt = 0

function pad(n) {
  return String(n).padStart(2, '0')
}

function countdown(ms) {
  const s = Math.ceil(ms / 1000)
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

export function register(on, options) {
  if (typeof options.ttlMinutes === 'number' && options.ttlMinutes > 0) {
    ttlMs = options.ttlMinutes * 60_000
  }

  on('session.start', async ($, e, next) => {
    // Not cancelled on session.end: /clear ends a session without starting the
    // mod again, so the next conversation needs the same timer.
    $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  // Subagents send a different prefix, so their requests leave the main cache
  // as it was.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    // The cache's lifetime starts when the request is sent, not when its
    // response finishes streaming.
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    if (result.usage) touchedAt = sentAt
    return result
  })

  on('session.end', async ($, e, next) => {
    touchedAt = 0
    return next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { value: warm } = await $.state.get({ plugin: 'cache-warmer', key: 'warm' })
    const last = Math.max(touchedAt, warm?.lastPingAt ?? 0)
    if (last === 0) return next(e)
    const left = last + ttlMs - (await $.clock.now())
    const label = left > 0 ? `cache ${countdown(left)}` : 'cache cold'
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })
}
