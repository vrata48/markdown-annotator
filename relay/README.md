# Relay for shared sessions

A Cloudflare Worker with one Durable Object per shared session ("room"). It
is deliberately dumb: it appends opaque strings to a per-room log, broadcasts
them to the other connected browsers, replays the log to late joiners, and
deletes the room a day after the last message. The app encrypts every message
in the browser with a key that lives only in the share link's URL fragment,
so the relay never holds anything it could read.

The wire protocol is documented at the top of `src/index.js` and exercised by
`test/relay.test.cjs`.

## Deploy

```sh
cd relay
npx wrangler login          # once per machine
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, for example
`https://md-annotator-relay.<your-subdomain>.workers.dev`. Put its `wss://`
form into `RELAY_URL` at the top of `collab.js` and bump the `collab.js?v=N`
cache-buster in `index.html`. The page's Content Security Policy already
allows `wss://*.workers.dev`; a custom domain needs adding to `connect-src`.

Durable Objects with SQLite storage are available on the free plan; a handful
of sessions costs nothing. There is no database to manage and nothing to back
up, since rooms are ephemeral by design.

## Configuration (`wrangler.toml`)

| Var               | Default | Meaning |
| ----------------- | ------- | ------- |
| `ROOM_TTL_HOURS`  | `24`    | A room is deleted this long after its last message. |
| `ALLOWED_ORIGINS` | empty   | Comma-separated page origins allowed to connect. Empty accepts any origin. |

Limits baked into the code: 4 MB per message, 16 MB per room.

## Run locally

```sh
cd relay
npx wrangler dev            # ws://127.0.0.1:8787
```

When the app itself is served from `localhost` or `127.0.0.1` it uses that
address automatically. Any page can override the relay with
`localStorage.setItem('relay-url', 'ws://host:port')`.

## Test

```sh
node --test relay/test/relay.test.cjs   # protocol, against a local wrangler dev
node tests/collab-e2e.cjs               # two browsers sharing a document through it
```

The first run downloads wrangler and its local runtime.
