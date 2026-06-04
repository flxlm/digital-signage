// digital-signage — a small ScreenCloud replacement.
//
// Each screen is a mini-PC in kiosk mode pointed at `/screen/<id>`. The player
// page polls a tiny authenticated API for the URL it should embed (plus an
// optional full-screen priority image), and crossfades to new content when it
// changes. Your portal calls the write API server-side to change what a screen
// shows on command. No scheduling, no playlists — web URLs + change-on-command.
//
// See README.md for the framing/embeddability requirements and API reference.

// --- Tunable knobs -----------------------------------------------------------
// How often the player re-checks its config. With N screens polling every P
// seconds, P >= N * 86400 / 80000 (~N*1.1s) keeps you under the free-tier
// 100k-requests/day cap with headroom. 30s comfortably supports ~30 screens.
const POLL_INTERVAL_MS = 30_000;
// Edge-cache TTL for the public poll response (Cache API + KV cacheTtl). Kept
// in lockstep with the poll interval; writes explicitly invalidate the entry.
const CACHE_TTL_SECONDS = 30;
// KV key namespace. Record for screen "lobby-01" lives at "screen:lobby-01".
const KEY_PREFIX = "screen:";
// Screen ids are used in KV keys, R2 paths and URLs — keep them boring.
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
// Resolution hint, e.g. "1920x1080".
const RESOLUTION_RE = /^\d{2,5}x\d{2,5}$/;
const ORIENTATIONS = [
  "landscape",
  "portrait",
  "landscape-flipped",
  "portrait-flipped",
] as const;
type Orientation = (typeof ORIENTATIONS)[number];
// Priority-image upload limits.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // ~10MB
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
// -----------------------------------------------------------------------------

interface Env {
  SIGNAGE: KVNamespace;
  MEDIA: R2Bucket;
  ADMIN_TOKEN: string;
}

interface PriorityImage {
  key: string;
  contentType: string;
  uploadedAt: string;
}

interface ScreenRecord {
  name: string;
  url: string;
  mode: "iframe";
  orientation: Orientation;
  resolution?: string;
  priorityImage?: PriorityImage | null;
  version: number;
  updatedAt: string;
}

// --- Router ------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error("[digital-signage]", err);
      const message = err instanceof Error ? err.message : "Internal error";
      return json({ error: message }, status);
    }
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  // CORS preflight for any API route.
  if (method === "OPTIONS" && pathname.startsWith("/api/")) {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // GET / — health check.
  if (pathname === "/" && method === "GET") {
    return new Response("digital-signage ok", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // GET /screen/:id — the kiosk player page.
  const playerMatch = pathname.match(/^\/screen\/([^/]+)$/);
  if (playerMatch && method === "GET") {
    return servePlayerHtml(decodeURIComponent(playerMatch[1]));
  }

  // GET /media/<key...> — public R2 media stream.
  if (pathname.startsWith("/media/") && (method === "GET" || method === "HEAD")) {
    return serveMedia(req, env, decodeURIComponent(pathname.slice("/media/".length)));
  }

  // GET /api/screens — admin list.
  if (pathname === "/api/screens" && method === "GET") {
    requireAuth(req, env);
    return listScreens(env);
  }

  // /api/screen/:id and /api/screen/:id/priority
  const screenMatch = pathname.match(/^\/api\/screen\/([^/]+)(\/priority)?$/);
  if (screenMatch) {
    const id = decodeURIComponent(screenMatch[1]);
    const isPriority = Boolean(screenMatch[2]);

    if (!isPriority) {
      if (method === "GET") return getPublicConfig(req, env, id);
      if (method === "PUT" || method === "POST") {
        requireAuth(req, env);
        return setScreen(req, env, id, url.origin);
      }
      if (method === "DELETE") {
        requireAuth(req, env);
        return deleteScreen(env, id, url.origin);
      }
    } else {
      if (method === "PUT") {
        requireAuth(req, env);
        return setPriority(req, env, id, url.origin);
      }
      if (method === "DELETE") {
        requireAuth(req, env);
        return clearPriority(env, id, url.origin);
      }
    }
  }

  return json({ error: "Not found" }, 404);
}

// --- Public API --------------------------------------------------------------

// The poll endpoint each player hits. Served from the Cache API when warm,
// falls back to KV, and supports ETag/If-None-Match → 304 to minimise reads.
async function getPublicConfig(req: Request, env: Env, id: string): Promise<Response> {
  if (!isValidId(id)) throw new HttpError(400, "Invalid screen id");

  const cache = caches.default;
  const cacheKey = configCacheKey(new URL(req.url).origin, id);

  let cached = await cache.match(cacheKey);
  if (!cached) {
    const rec = await env.SIGNAGE.get<ScreenRecord>(KEY_PREFIX + id, {
      type: "json",
      cacheTtl: CACHE_TTL_SECONDS,
    });
    if (!rec) {
      // Don't cache misses — a screen can be assigned at any moment.
      return json({ error: "No content assigned", id }, 404);
    }
    const payload = toPublicConfig(id, rec);
    cached = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
        etag: `"v${rec.version}"`,
      },
    });
    await cache.put(cacheKey, cached.clone());
  }

  // Honour conditional requests so warm players get a cheap 304.
  const etag = cached.headers.get("etag");
  const inm = req.headers.get("if-none-match");
  if (etag && inm && inm === etag) {
    return new Response(null, {
      status: 304,
      headers: { ...corsHeaders(), etag, "cache-control": `public, max-age=${CACHE_TTL_SECONDS}` },
    });
  }

  const headers = new Headers(cached.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(cached.body, { status: 200, headers });
}

function toPublicConfig(id: string, rec: ScreenRecord) {
  return {
    id,
    name: rec.name,
    url: rec.url,
    mode: rec.mode,
    orientation: rec.orientation,
    resolution: rec.resolution ?? null,
    priorityImageUrl: rec.priorityImage ? `/media/${rec.priorityImage.key}` : null,
    version: rec.version,
    updatedAt: rec.updatedAt,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

// Streams a priority image out of R2 with a long immutable cache. Keys are
// uuid-named so they never change content → safe to cache forever.
async function serveMedia(req: Request, env: Env, key: string): Promise<Response> {
  if (!key || key.includes("..")) throw new HttpError(400, "Invalid media key");

  const inm = req.headers.get("if-none-match");
  const obj = await env.MEDIA.get(key, {
    onlyIf: inm ? { etagDoesNotMatch: inm.replace(/"/g, "") } : undefined,
  });
  if (!obj) {
    // Either a genuine miss, or a 304 (onlyIf failed → body is null but the
    // object exists). Disambiguate with a head check.
    if (inm) {
      const head = await env.MEDIA.head(key);
      if (head) {
        return new Response(null, {
          status: 304,
          headers: {
            etag: `"${head.httpEtag.replace(/"/g, "")}"`,
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }
    }
    return json({ error: "Not found" }, 404);
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  return new Response(req.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

// --- Admin API ---------------------------------------------------------------

async function listScreens(env: Env): Promise<Response> {
  const screens: Array<ReturnType<typeof toPublicConfig>> = [];
  let cursor: string | undefined;
  do {
    const res = await env.SIGNAGE.list({ prefix: KEY_PREFIX, cursor });
    for (const k of res.keys) {
      const id = k.name.slice(KEY_PREFIX.length);
      const rec = await env.SIGNAGE.get<ScreenRecord>(k.name, { type: "json" });
      if (rec) screens.push(toPublicConfig(id, rec));
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);

  screens.sort((a, b) => a.id.localeCompare(b.id));
  return json({ screens }, 200, corsHeaders());
}

async function setScreen(req: Request, env: Env, id: string, origin: string): Promise<Response> {
  if (!isValidId(id)) throw new HttpError(400, "Invalid screen id (use [a-zA-Z0-9_-], 1-64 chars)");

  const body = await readJson(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new HttpError(400, "name is required");
  if (name.length > 120) throw new HttpError(400, "name too long");

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!isValidUrl(url)) throw new HttpError(400, "url must be a valid http(s) URL");

  const orientation = (body.orientation ?? "landscape") as Orientation;
  if (!ORIENTATIONS.includes(orientation)) {
    throw new HttpError(400, `orientation must be one of: ${ORIENTATIONS.join(", ")}`);
  }

  let resolution: string | undefined;
  if (body.resolution != null && body.resolution !== "") {
    resolution = String(body.resolution).trim();
    if (!RESOLUTION_RE.test(resolution)) {
      throw new HttpError(400, "resolution must look like 1920x1080");
    }
  }

  // Upsert: preserve the existing priority image + bump the version.
  const existing = await env.SIGNAGE.get<ScreenRecord>(KEY_PREFIX + id, { type: "json" });
  const rec: ScreenRecord = {
    name,
    url,
    mode: "iframe",
    orientation,
    resolution,
    priorityImage: existing?.priorityImage ?? null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  await env.SIGNAGE.put(KEY_PREFIX + id, JSON.stringify(rec));
  await invalidateConfig(origin, id);

  const warnings = url.startsWith("http://")
    ? ["http:// URLs are blocked as mixed content on https screens — use https://"]
    : [];
  return json({ ok: true, screen: toPublicConfig(id, rec), warnings }, 200, corsHeaders());
}

async function deleteScreen(env: Env, id: string, origin: string): Promise<Response> {
  if (!isValidId(id)) throw new HttpError(400, "Invalid screen id");
  const existing = await env.SIGNAGE.get<ScreenRecord>(KEY_PREFIX + id, { type: "json" });
  if (existing?.priorityImage) {
    await env.MEDIA.delete(existing.priorityImage.key);
  }
  await env.SIGNAGE.delete(KEY_PREFIX + id);
  await invalidateConfig(origin, id);
  return json({ ok: true }, 200, corsHeaders());
}

// Accepts an image as multipart/form-data (field "file"/"image") or as a raw
// body with a Content-Type header. Stores it in R2 and points the record at it.
async function setPriority(req: Request, env: Env, id: string, origin: string): Promise<Response> {
  if (!isValidId(id)) throw new HttpError(400, "Invalid screen id");
  const existing = await env.SIGNAGE.get<ScreenRecord>(KEY_PREFIX + id, { type: "json" });
  if (!existing) throw new HttpError(404, "Screen not found — create it first");

  let bytes: ArrayBuffer;
  let contentType: string;

  const reqType = req.headers.get("content-type") ?? "";
  if (reqType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = (form.get("file") ?? form.get("image")) as unknown;
    if (!(file instanceof File)) throw new HttpError(400, "Expected a file field named 'file'");
    contentType = file.type || "application/octet-stream";
    bytes = await file.arrayBuffer();
  } else {
    contentType = reqType.split(";")[0].trim().toLowerCase();
    bytes = await req.arrayBuffer();
  }

  contentType = contentType.toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new HttpError(400, `Unsupported image type "${contentType}" (allowed: ${[...ALLOWED_IMAGE_TYPES].join(", ")})`);
  }
  if (bytes.byteLength === 0) throw new HttpError(400, "Empty upload");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, `Image too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
  }

  const ext = EXT_BY_TYPE[contentType] ?? "bin";
  const newKey = `priority/${id}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(newKey, bytes, { httpMetadata: { contentType } });

  // Swap the pointer first, then clean up the old object so a failure can't
  // leave the record pointing at a deleted file.
  const oldKey = existing.priorityImage?.key;
  const rec: ScreenRecord = {
    ...existing,
    priorityImage: { key: newKey, contentType, uploadedAt: new Date().toISOString() },
    version: existing.version + 1,
    updatedAt: new Date().toISOString(),
  };
  await env.SIGNAGE.put(KEY_PREFIX + id, JSON.stringify(rec));
  if (oldKey && oldKey !== newKey) await env.MEDIA.delete(oldKey);
  await invalidateConfig(origin, id);

  return json({ ok: true, screen: toPublicConfig(id, rec) }, 200, corsHeaders());
}

async function clearPriority(env: Env, id: string, origin: string): Promise<Response> {
  if (!isValidId(id)) throw new HttpError(400, "Invalid screen id");
  const existing = await env.SIGNAGE.get<ScreenRecord>(KEY_PREFIX + id, { type: "json" });
  if (!existing) throw new HttpError(404, "Screen not found");
  if (existing.priorityImage) await env.MEDIA.delete(existing.priorityImage.key);

  const rec: ScreenRecord = {
    ...existing,
    priorityImage: null,
    version: existing.version + 1,
    updatedAt: new Date().toISOString(),
  };
  await env.SIGNAGE.put(KEY_PREFIX + id, JSON.stringify(rec));
  await invalidateConfig(origin, id);
  return json({ ok: true, screen: toPublicConfig(id, rec) }, 200, corsHeaders());
}

// --- Helpers -----------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function requireAuth(req: Request, env: Env): void {
  if (!env.ADMIN_TOKEN) throw new HttpError(500, "ADMIN_TOKEN is not configured");
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    throw new HttpError(401, "Unauthorized");
  }
}

// Length-independent constant-time comparison.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, if-none-match",
    "access-control-max-age": "86400",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    if (data && typeof data === "object") return data as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Expected a JSON object body");
}

function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function configCacheKey(origin: string, id: string): Request {
  return new Request(`${origin}/api/screen/${encodeURIComponent(id)}`);
}

async function invalidateConfig(origin: string, id: string): Promise<void> {
  await caches.default.delete(configCacheKey(origin, id));
}

// --- Player HTML -------------------------------------------------------------

function servePlayerHtml(id: string): Response {
  if (!isValidId(id)) {
    return new Response("Invalid screen id", { status: 400 });
  }
  const html = PLAYER_HTML.replace(/__SCREEN_ID__/g, id).replace(
    /__POLL_INTERVAL_MS__/g,
    String(POLL_INTERVAL_MS),
  );
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The shell itself rarely changes; let the browser cache it briefly but
      // the player keeps polling the API for actual content.
      "cache-control": "public, max-age=60",
    },
  });
}

const PLAYER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>Screen __SCREEN_ID__</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
  #stage { position: fixed; inset: 0; background: #000; }
  /* The rotator sits inside the stage and is sized/rotated per orientation. */
  #rotator { position: absolute; top: 50%; left: 50%; transform-origin: center center; }
  .layer {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: 0; opacity: 0; transition: opacity 600ms ease; background: #000;
  }
  .layer.visible { opacity: 1; }
  img.layer { object-fit: contain; }
  #placeholder {
    position: fixed; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 12px;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: #888; text-align: center; padding: 24px;
  }
  #placeholder .id { font-size: 6vmin; color: #ccc; font-weight: 600; letter-spacing: 0.04em; }
  #placeholder .msg { font-size: 2.4vmin; }
  #diag {
    position: fixed; left: 12px; bottom: 12px; z-index: 10;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.4; color: #9aa; background: rgba(0,0,0,0.55);
    padding: 8px 10px; border-radius: 6px; max-width: 60vw;
    opacity: 0; transition: opacity 400ms ease; pointer-events: none;
  }
  #diag.show { opacity: 1; }
</style>
</head>
<body>
  <div id="stage"><div id="rotator"></div></div>
  <div id="placeholder">
    <div class="id">__SCREEN_ID__</div>
    <div class="msg">No content assigned yet. This screen will update automatically.</div>
  </div>
  <div id="diag"></div>
<script>
(function () {
  var SCREEN_ID = "__SCREEN_ID__";
  var POLL_MS = __POLL_INTERVAL_MS__;
  var CACHE_KEY = "signage:lastgood:" + SCREEN_ID;

  var stage = document.getElementById("stage");
  var rotator = document.getElementById("rotator");
  var placeholder = document.getElementById("placeholder");
  var diag = document.getElementById("diag");

  var current = null;       // last applied config
  var etag = null;          // last seen ETag for conditional polling
  var layers = [];          // the two stacked content layers
  var front = 0;            // index of the currently-visible layer

  // Restore last-good config instantly on boot so a reboot isn't a blank screen.
  try {
    var saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (saved && saved.config) apply(saved.config, true);
  } catch (e) {}

  function applyOrientation(cfg) {
    // Size the rotator to the viewport (swapping w/h for portrait) and rotate.
    var vw = window.innerWidth, vh = window.innerHeight;
    var o = (cfg && cfg.orientation) || "landscape";
    var deg = 0, w = vw, h = vh;
    if (o === "portrait") { deg = 90; w = vh; h = vw; }
    else if (o === "portrait-flipped") { deg = 270; w = vh; h = vw; }
    else if (o === "landscape-flipped") { deg = 180; w = vw; h = vh; }
    rotator.style.width = w + "px";
    rotator.style.height = h + "px";
    rotator.style.transform = "translate(-50%, -50%) rotate(" + deg + "deg)";
  }

  function makeLayer(cfg) {
    var el;
    if (cfg.priorityImageUrl) {
      el = document.createElement("img");
      el.className = "layer";
      el.src = cfg.priorityImageUrl;
    } else {
      el = document.createElement("iframe");
      el.className = "layer";
      el.setAttribute("allow", "autoplay; fullscreen; encrypted-media");
      el.setAttribute("referrerpolicy", "no-referrer");
      el.src = embedUrl(cfg.url);
    }
    return el;
  }

  // Some sites only frame cleanly via a dedicated embed URL. Canva is the common
  // one: a design's public ".../view" link (what you copy from the address bar)
  // refuses to embed, but the same link with Canva's "embed" param — exactly
  // what Canva's own "Smart embed" snippet uses — does. Convert it transparently
  // so pasting the plain view link just works. Anything else is passed through.
  // NOTE: this whole script lives inside a JS template literal, so avoid regex
  // literals with escaped slashes here — the escapes collapse at runtime and
  // produce invalid JS that kills the whole player. Plain string ops only.
  function embedUrl(raw) {
    try {
      var u = new URL(raw);
      var host = u.hostname.toLowerCase();
      var isCanva = host === "canva.com" || host.slice(-10) === ".canva.com";
      var parts = u.pathname.split("/").filter(function (s) { return s; });
      var isDesignView =
        parts.length === 4 &&
        parts[0] === "design" &&
        (parts[3] === "view" || parts[3] === "watch");
      if (isCanva && isDesignView && !u.searchParams.has("embed")) {
        return u.origin + u.pathname + u.search + (u.search ? "&" : "?") + "embed" + u.hash;
      }
    } catch (e) {}
    return raw;
  }

  // What makes two configs visually identical (so we don't reload needlessly).
  function renderKey(cfg) {
    return (cfg.priorityImageUrl ? "img:" + cfg.priorityImageUrl : "url:" + cfg.url) +
      "|" + (cfg.orientation || "landscape") + "|v" + cfg.version;
  }

  function apply(cfg, instant) {
    placeholder.style.display = "none";
    applyOrientation(cfg);

    if (current && renderKey(current) === renderKey(cfg)) {
      current = cfg;
      return;
    }

    var next = makeLayer(cfg);
    rotator.appendChild(next);

    var reveal = function () {
      // Crossfade: show next, hide previous, then drop old layers.
      if (instant) next.style.transition = "none";
      // Force a reflow so the transition runs from opacity 0.
      void next.offsetWidth;
      next.classList.add("visible");
      for (var i = 0; i < layers.length; i++) {
        (function (old) {
          old.classList.remove("visible");
          setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 800);
        })(layers[i]);
      }
      layers = [next];
      if (instant) { void next.offsetWidth; next.style.transition = ""; }
    };

    if (next.tagName === "IMG") {
      if (next.complete) reveal(); else { next.onload = reveal; next.onerror = reveal; }
    } else {
      // Cross-origin iframe load events are unreliable; reveal on load OR after
      // a short timeout so we never get stuck on a black frame.
      var done = false;
      var go = function () { if (!done) { done = true; reveal(); } };
      next.onload = go;
      setTimeout(go, 2500);
    }

    current = cfg;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ config: cfg, at: Date.now() })); } catch (e) {}
    updateDiag(cfg);
  }

  function showPlaceholder() {
    if (current) return; // keep showing last-good content if we ever had any
    placeholder.style.display = "flex";
  }

  function updateDiag(cfg) {
    var bits = ["id: " + SCREEN_ID];
    if (cfg) {
      bits.push("orientation: " + (cfg.orientation || "landscape"));
      if (cfg.resolution) bits.push("res: " + cfg.resolution);
      bits.push("v" + cfg.version);
      if (!cfg.priorityImageUrl) bits.push("if blank, the URL may not allow embedding");
    }
    diag.textContent = bits.join("  ·  ");
    diag.classList.add("show");
    clearTimeout(updateDiag._t);
    updateDiag._t = setTimeout(function () { diag.classList.remove("show"); }, 8000);
  }

  async function poll() {
    try {
      var headers = {};
      if (etag) headers["If-None-Match"] = etag;
      var res = await fetch("/api/screen/" + encodeURIComponent(SCREEN_ID), {
        headers: headers, cache: "no-store",
      });
      if (res.status === 304) return;
      if (res.status === 404) { showPlaceholder(); return; }
      if (!res.ok) return;
      etag = res.headers.get("ETag") || etag;
      var cfg = await res.json();
      apply(cfg, false);
    } catch (e) {
      // Network blip — keep showing whatever we have and try again next tick.
    }
  }

  window.addEventListener("resize", function () { if (current) applyOrientation(current); });
  poll();
  setInterval(poll, POLL_MS);
})();
</script>
</body>
</html>`;
