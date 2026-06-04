# digital-signage

A tiny Cloudflare Worker that replaces ScreenCloud for "point a kiosk at a URL
and change it remotely." Each screen is a cheap mini-PC running a browser in
fullscreen/kiosk mode, pointed once at `https://<worker>/screen/<id>`. The Worker
stores per-screen settings (the URL to show, orientation/resolution, and an
optional priority image), serves the player page, and exposes a small
authenticated API your portal calls to change what a screen shows — on command.

No scheduling, no playlists. Web URLs plus the occasional "show this now" image.

## How it works

- Each mini-PC opens `/screen/<id>` once and never changes. The page polls
  `GET /api/screen/<id>` every **30s** for its config and **crossfades** to new
  content when the `version` changes — no reload, no white flash.
- Config lives in **KV** (`screen:<id>`). Priority images live in **R2**
  (bucket `MEDIA`). Your portal changes content with the authenticated write API.
- The poll response is served from the **Cache API** (30s) with an `ETag`, and
  players send `If-None-Match` for cheap `304`s, so steady-state KV reads are
  near zero. Writes invalidate the cache so changes still propagate within the
  poll interval.
- The player keeps a **`localStorage` last-good** copy, so a reboot or a network
  blip shows the last content instantly instead of a blank screen.

## Content & framing requirements (read this before configuring screens)

The player shows the target site in a **full-viewport iframe**. Many sites refuse
to be embedded via `X-Frame-Options` / CSP `frame-ancestors` (Google apps, most
SaaS dashboards, news/social). The diagnostic overlay warns "if blank, the URL
may not allow embedding."

**Use content that is designed to embed** — which is exactly what signage uses:

- **Google Slides** — File → Share → Publish to web → Embed:
  `https://docs.google.com/presentation/d/…/pub?start=true&loop=true&delayms=5000`
- **Published Google Sheets / Docs** (`/pub?embedded=true`)
- **Canva** public "Smart embed" links
- **Looker Studio** reports (embeddable; enable embedding)
- **Power BI** publish-to-web embed URLs
- **YouTube** embeds (`https://www.youtube.com/embed/<id>?autoplay=1&mute=1&loop=1`)
- **Notion** public pages
- **Any page you control** (set your own framing headers)

> A reverse proxy that strips frame headers is **explicitly out of scope** — it
> breaks relative assets, same-origin SPA APIs, and cookies/auth, and only
> "works" for static pages that already embed fine. Configure screens with
> embeddable content instead.

## Orientation & resolution

Each screen carries an `orientation`:

- `landscape` (default), `portrait`, `landscape-flipped`, `portrait-flipped`.

The player applies a **CSS rotate transform** to the content so a physically
rotated portrait screen displays correctly **even when the OS/browser isn't
rotating output**. The same transform wraps both the iframe and the priority
image.

> **OS-rotation caveat:** if your mini-PC already rotates the display at the OS
> level, leave `orientation = landscape` to avoid double-rotation.

`resolution` (optional, e.g. `1920x1080`) is informational and shown in the
on-screen diagnostic overlay.

## Priority image override

For event-driven "show this now" moments, set a per-screen **priority image**.
While set, the player shows it full-screen (letterboxed on black, orientation
applied) **instead of** the URL. Clear it and the screen reverts to its URL — no
reconfiguration.

Images are stored in R2 under `priority/<id>/<uuid>.<ext>` (immutable → safely
cacheable) and served from `/media/<key>` with a one-year immutable cache.
Allowed types: `png`, `jpeg`, `webp`, `gif`; max ~10 MB.

> Alternatively, your portal may write the object to R2 directly (its own
> binding / presigned URL) and just set `priorityImage` via the normal screen
> `PUT` — same field either way.

## API reference

All write endpoints require `Authorization: Bearer <ADMIN_TOKEN>`. CORS is
enabled so a browser UI *can* call these, **but call the write APIs server-side
so `ADMIN_TOKEN` never reaches a browser.**

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | — | Health check (`digital-signage ok`). |
| `GET` | `/screen/:id` | — | The kiosk player page. |
| `GET` | `/api/screen/:id` | — | Poll config (Cache API → KV; `ETag`/`304`; `404` if unset). |
| `PUT`/`POST` | `/api/screen/:id` | ✓ | Create/update a screen. |
| `DELETE` | `/api/screen/:id` | ✓ | Delete a screen (+ its priority image). |
| `PUT` | `/api/screen/:id/priority` | ✓ | Upload a priority image. |
| `DELETE` | `/api/screen/:id/priority` | ✓ | Clear the priority image. |
| `GET` | `/media/<key>` | — | Stream an R2 media object (long immutable cache). |
| `GET` | `/api/screens` | ✓ | List all screens. |

### Examples

```bash
WORKER=https://digital-signage.<your-subdomain>.workers.dev
TOKEN=<your-admin-token>

# Assign a published Google Slides deck to a portrait screen
curl -X PUT "$WORKER/api/screen/lobby-01" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Lobby",
        "url": "https://docs.google.com/presentation/d/ABC/pub?start=true&loop=true&delayms=5000",
        "orientation": "portrait",
        "resolution": "1080x1920"
      }'

# Read the public poll config (what the player sees)
curl "$WORKER/api/screen/lobby-01"

# Push a "show this now" image (raw body + Content-Type)
curl -X PUT "$WORKER/api/screen/lobby-01/priority" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @alert.png

# …or as multipart
curl -X PUT "$WORKER/api/screen/lobby-01/priority" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@alert.png"

# Clear the image → reverts to the URL
curl -X DELETE "$WORKER/api/screen/lobby-01/priority" -H "Authorization: Bearer $TOKEN"

# List + delete
curl "$WORKER/api/screens" -H "Authorization: Bearer $TOKEN"
curl -X DELETE "$WORKER/api/screen/lobby-01" -H "Authorization: Bearer $TOKEN"
```

## Scale & cost (free tier is fine)

Free-tier limits that matter: **100k Worker requests/day** and **100k KV
reads/day** (writes are 1k/day, but writes only happen when you change content).
With N screens polling every P seconds:

> **P ≥ N × 86,400 / 80,000 ≈ N × 1.1 s**

| Poll interval | Screens supported (free tier) |
| --- | --- |
| 30s (default) | ~30 |
| 60s | ~60 |
| 120s | ~120 |

The Cache API + `304` responses push real KV reads far below the cap. R2's free
tier (10 GB, 1M Class-A, 10M Class-B/mo, no egress) is far beyond this use.

There is **no heartbeat/online-status** (it would mean a KV write per ping);
on-device resilience comes from the player's `localStorage` cache instead.

## Setup

```bash
cd digital-signage && npm install

# KV (paste the printed id into wrangler.toml)
wrangler kv namespace create SIGNAGE
# optional, for `wrangler dev`:
wrangler kv namespace create SIGNAGE --preview

# R2
wrangler r2 bucket create digital-signage-media

# Deploy + secret
wrangler deploy
wrangler secret put ADMIN_TOKEN        # a long random token

wrangler tail                          # watch live requests
```

For local dev, put `ADMIN_TOKEN=devtoken` in a gitignored `.dev.vars` and run
`wrangler dev`.

## Portal integration

Point the browser of each mini-PC at `https://<worker>/screen/<id>` in
fullscreen/kiosk mode. Manage screens from your portal by calling the write APIs
**server-side** (the admin token stays on the server). CORS is enabled so a
browser UI *can* call them directly, but doing so would expose the token — don't.

## Out of scope (possible future adds)

`redirect`/proxy modes for non-embeddable sites, time-based scheduling,
playlists, video hosting, and online/heartbeat presence tracking.
