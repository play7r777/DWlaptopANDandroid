// Rule34 DW Button — content script.
//
// Runs on every page of rule34.xxx. Adds:
//   - a "DW" download button to every <span class="thumb"> in the listing
//   - a fixed bottom-right "DW" button on each individual post page
//   - a compact toolbar in the top-right corner with one toggle: "Easy-select"
//     — when on, clicking anywhere on a thumbnail enqueues it for download
//     (no need to aim at the small DW button).
//
// Click-to-download model: every click on a thumb (or its DW button) adds the
// post to a persistent FIFO queue in chrome.storage.local. A worker pops one
// item at a time, resolves the original-file URL, hands it to the background
// service worker for a silent download (saveAs:false → straight into
// Downloads/rule34/), then moves to the next item. The queue survives page
// navigation, tab switches, and browser restarts; a TTL lock makes sure two
// tabs never process the same item twice.

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Configuration & helpers
    // ------------------------------------------------------------------

    const BTN_LABEL = 'DW';
    const STORAGE_KEY_EASY  = 'r34dw_easyselect'; // boolean — click anywhere on thumb to enqueue
    const STORAGE_KEY_CACHE = 'r34dw_urlcache';   // {id: {url, ts}} — resolved file URLs
    const STORAGE_KEY_QUEUE = 'r34dw_queue';      // string[] of post IDs — FIFO download queue
    const STORAGE_KEY_LOCK  = 'r34dw_qlock';      // {tab, ts} — cross-tab worker lock, TTL refreshed every LOCK_REFRESH_MS

    // A short tab key so the lock distinguishes between tabs of the same
    // session. Regenerated per page-load — that's fine, we only care about
    // ownership while this content script is alive.
    const TAB_KEY = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    const LOCK_TTL_MS     = 6000;
    const LOCK_REFRESH_MS = 2000;

    // Maximum number of resolved URLs to keep cached. Older entries get evicted.
    const URL_CACHE_LIMIT = 2000;
    // Cache TTL — rule34 occasionally re-hashes filenames, so don't trust forever.
    const URL_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

    function fileNameFromUrl(url) {
        try {
            const u = new URL(url, location.href);
            const last = u.pathname.split('/').filter(Boolean).pop() || 'rule34_download';
            return decodeURIComponent(last);
        } catch (_) {
            const m = String(url).split('?')[0].split('/').filter(Boolean).pop();
            return m || 'rule34_download';
        }
    }

    function notify(text, isError, ttl) {
        try {
            const n = document.createElement('div');
            n.textContent = text;
            n.style.cssText = [
                'position:fixed',
                'left:50%',
                'bottom:24px',
                'transform:translateX(-50%)',
                'z-index:2147483647',
                'padding:10px 16px',
                'border-radius:8px',
                'font:600 14px/1.2 system-ui, sans-serif',
                'color:#fff',
                'background:' + (isError ? '#b00020' : '#222'),
                'box-shadow:0 4px 14px rgba(0,0,0,.35)',
                'pointer-events:none',
                'opacity:0',
                'max-width:90vw',
                'text-align:center',
                'transition:opacity .2s ease'
            ].join(';') + ';';
            document.body.appendChild(n);
            requestAnimationFrame(() => { n.style.opacity = '1'; });
            setTimeout(() => {
                n.style.opacity = '0';
                setTimeout(() => n.remove(), 250);
            }, ttl || 2200);
        } catch (_) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // chrome.* wrappers
    // ------------------------------------------------------------------

    const ext = (typeof browser !== 'undefined' ? browser
              : typeof chrome  !== 'undefined' ? chrome
              : null);

    function storageGet(key, def) {
        return new Promise((resolve) => {
            try {
                ext.storage.local.get([key], (out) => {
                    if (ext.runtime.lastError) { resolve(def); return; }
                    const v = out && out[key];
                    resolve(v === undefined ? def : v);
                });
            } catch (_) { resolve(def); }
        });
    }
    function storageSet(key, value) {
        try { ext.storage.local.set({ [key]: value }); } catch (_) { /* ignore */ }
    }

    function sendDownload(url, filename) {
        return new Promise((resolve) => {
            try {
                ext.runtime.sendMessage({ type: 'download', url, filename }, (resp) => {
                    if (ext.runtime.lastError) {
                        resolve({ ok: false, error: String(ext.runtime.lastError.message || ext.runtime.lastError) });
                        return;
                    }
                    resolve(resp || { ok: false, error: 'no response' });
                });
            } catch (e) {
                resolve({ ok: false, error: String(e && e.message || e) });
            }
        });
    }

    // ------------------------------------------------------------------
    // Resolve a post → highest-quality source URL
    //
    // Priority chain (best to worst):
    //   1. <a> "Original image" / "Original video" / "Original" — the source link.
    //   2. <meta property="og:image"> — set by rule34 to the source CDN URL.
    //   3. Any <a> pointing at the source CDN with a media extension, sorted by
    //      preferred extension (video > png > jpg > gif > webp).
    //   4. <video> source/src (skip /samples/).
    //   5. <img id="image"> src (skip /samples/ — last resort).
    //
    // On bulk operations, if HTML fetch fails (429/403/CSP/etc.), we fall back
    // to the rule34 JSON API via the service worker.
    // ------------------------------------------------------------------

    // Recognise files served from rule34's image CDN (any subdomain works:
    // wimg, img, etc) and exclude /samples/ paths since those are downscaled.
    const SOURCE_HREF_RE = /(?:^|\/\/)(?:[a-z0-9-]+\.)?rule34\.xxx\/+images\//i;
    const FILE_EXT_RE    = /\.(png|jpe?g|gif|webm|mp4|webp)(?:\?|#|$)/i;
    const SAMPLE_PATH_RE = /\/+samples?\//i;
    const PHP_PATH_RE    = /\.php(?:\?|#|$)/i;

    // Quality ranking — used ONLY as a tiebreaker between multiple CDN anchors
    // when no explicit "Original image/video" text exists. The "Original" anchor
    // and og:image meta are always trusted first, so this ranking does NOT
    // override a post whose true original is jpg with a smaller png preview.
    //
    // - Video formats (webm/mp4) win when both video and image candidates
    //   exist, because that means it's a video post.
    // - png / jpg / jpeg / gif are equal — any of them can be the actual
    //   original, we trust whichever rule34 surfaces.
    // - webp ranks last because rule34 often serves webp as a resampled preview.
    const EXT_QUALITY = { webm: 100, mp4: 100, png: 90, jpg: 90, jpeg: 90, gif: 90, webp: 50 };
    function urlQualityScore(url) {
        const m = String(url || '').match(FILE_EXT_RE);
        if (!m) return 0;
        const ext = m[1].toLowerCase();
        return EXT_QUALITY[ext] || 10;
    }

    function isSourceHref(h) {
        if (!h) return false;
        if (PHP_PATH_RE.test(h)) return false;
        if (SAMPLE_PATH_RE.test(h)) return false;
        return SOURCE_HREF_RE.test(h) && FILE_EXT_RE.test(h);
    }

    // Validate ANY URL before sending it to chrome.downloads — must be a media
    // file, never a .php / HTML page.
    function isValidMediaUrl(url) {
        if (!url) return false;
        if (PHP_PATH_RE.test(url)) return false;
        return FILE_EXT_RE.test(url);
    }

    function pickBestSourceUrl(candidates) {
        let best = null;
        let bestScore = -1;
        for (const c of candidates) {
            if (!c) continue;
            if (!isValidMediaUrl(c)) continue;
            const s = urlQualityScore(c);
            if (s > bestScore) { best = c; bestScore = s; }
        }
        return best;
    }

    function findOriginalLinkInDoc(doc) {
        const links = doc.querySelectorAll('a[href]');

        // Priority 1: anchor whose visible text is "Original image / video / Original".
        // This is the gold standard — rule34 labels the literal source file with
        // this text. We TRUST it unconditionally; the file extension is whatever
        // the artist uploaded (jpg, png, gif, webm — all valid originals).
        for (const a of links) {
            const t = (a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t === 'original image' || t === 'original video' || t === 'original') {
                const h = a.getAttribute('href');
                if (isSourceHref(h)) return h;
            }
        }

        // Priority 2: og:image meta. rule34 sets this to the canonical source
        // CDN URL. If present and valid, this IS the original — no comparison
        // needed, because rule34 itself decided what the canonical file is.
        const og = doc.querySelector('meta[property="og:image"][content]');
        const ogHref = og && og.getAttribute('content');
        if (ogHref && isSourceHref(ogHref)) return ogHref;

        // Priority 3: scan ALL anchors to the source CDN. Two cases:
        //   a) Multiple anchors point at the SAME hash — that's the canonical
        //      file, just pick any of those (they're identical files).
        //   b) Anchors point at DIFFERENT files (rare — a multi-asset post).
        //      In that case, use EXT_QUALITY only to prefer video over image
        //      formats; image formats are equal so we trust DOM order (rule34
        //      lists the source first).
        const candidates = [];
        for (const a of links) {
            const h = a.getAttribute('href');
            if (isSourceHref(h)) candidates.push(h);
        }
        if (candidates.length === 0) return null;

        // Group by file hash (last path segment before any query) — if all
        // candidates share the same hash, just return the first one we found
        // (DOM order, which on rule34 corresponds to the "original" position).
        const hashes = new Set();
        for (const c of candidates) {
            try {
                const u = new URL(c, location.href);
                const last = u.pathname.split('/').filter(Boolean).pop() || '';
                hashes.add(last.replace(/\.[a-z0-9]+$/i, ''));
            } catch (_) {}
        }
        if (hashes.size === 1) return candidates[0];

        // Different files — use quality ranking strictly as a tiebreaker.
        return pickBestSourceUrl(candidates);
    }

    function findFileUrlInDoc(doc) {
        const original = findOriginalLinkInDoc(doc);
        if (original) return original;

        const vid = doc.getElementById('gelcomVideoPlayer') || doc.querySelector('video');
        if (vid) {
            const sourceEl = vid.querySelector('source[src]');
            const srcAttr  = (sourceEl && sourceEl.getAttribute('src')) || vid.getAttribute('src');
            if (srcAttr && !SAMPLE_PATH_RE.test(srcAttr) && isValidMediaUrl(srcAttr)) return srcAttr;
        }

        // Last resort: <img id="image">. We REJECT /samples/... here because for
        // many posts the displayed image is a downscaled sample even when an
        // actual source link exists higher up in priority.
        const img = doc.getElementById('image');
        const imgSrc = img && img.getAttribute('src');
        if (imgSrc && !SAMPLE_PATH_RE.test(imgSrc) && isValidMediaUrl(imgSrc)) return imgSrc;

        return null;
    }

    // Detect rule34's HTTP 429 / abuse-page responses. Real post pages are
    // 30-100KB; the rate-limit page is ~2KB and contains "Rate limiting".
    function isRateLimitedHtml(html) {
        if (!html || html.length < 4000) {
            if (/rate\s*limit|too many|429|captcha/i.test(html || '')) return true;
        }
        return false;
    }

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    function jitter(ms) { return ms + Math.floor(Math.random() * (ms * 0.4)); }

    function buildPostUrl(postId) {
        // Use the user's current origin so cookies (esp. on www.rule34.xxx)
        // travel with the request.
        const origin = (typeof location !== 'undefined' && location.origin) || 'https://rule34.xxx';
        return `${origin}/index.php?page=post&s=view&id=${encodeURIComponent(postId)}`;
    }

    function bgFetchPostHtml(url) {
        return new Promise((resolve, reject) => {
            try {
                ext.runtime.sendMessage({ type: 'fetchPostHtml', url }, (resp) => {
                    if (ext.runtime.lastError) {
                        reject(new Error(String(ext.runtime.lastError.message || ext.runtime.lastError)));
                        return;
                    }
                    if (!resp || !resp.ok) {
                        const e = new Error((resp && resp.error) || 'background fetch failed');
                        if (resp && resp.status) e.status = resp.status;
                        reject(e);
                        return;
                    }
                    resolve(resp.html || '');
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function bgFetchPostJson(postId) {
        return new Promise((resolve, reject) => {
            try {
                ext.runtime.sendMessage({ type: 'fetchPostJson', id: String(postId) }, (resp) => {
                    if (ext.runtime.lastError) {
                        reject(new Error(String(ext.runtime.lastError.message || ext.runtime.lastError)));
                        return;
                    }
                    if (!resp || !resp.ok) {
                        const e = new Error((resp && resp.error) || 'background JSON fetch failed');
                        if (resp && resp.status) e.status = resp.status;
                        reject(e);
                        return;
                    }
                    resolve(resp);
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    // Adaptive backoff for rate-limited responses. Shared across all in-flight
    // requests so the whole pool throttles when rule34 starts pushing back.
    let _rateLimitUntil = 0;
    async function awaitRateLimitWindow() {
        const wait = _rateLimitUntil - Date.now();
        if (wait > 0) await delay(wait);
    }
    function bumpRateLimit(ms) {
        const target = Date.now() + ms;
        if (target > _rateLimitUntil) _rateLimitUntil = target;
    }

    const MAX_FETCH_ATTEMPTS = 8;
    function backoffForAttempt(attempt) {
        // base 2s, exponential, capped at 30s, plus jitter to spread out
        // simultaneous retries.
        const base = Math.min(30000, 2000 * Math.pow(2, attempt - 1));
        return jitter(base);
    }

    async function fetchPostHtml(postId, attempt) {
        attempt = attempt || 1;
        await awaitRateLimitWindow();
        const url = buildPostUrl(postId);
        let html = null;
        let status = null;
        let rateLimited = false;
        let forbidden = false;
        let networkErr = null;

        // First attempt the page-context fetch. Carries cookies for the current
        // origin without needing service-worker permission tricks.
        try {
            const r = await fetch(url, {
                credentials: 'include',
                cache: 'no-cache',
                redirect: 'follow',
            });
            status = r.status;
            if (r.status === 429) {
                rateLimited = true;
            } else if (r.status === 403) {
                forbidden = true;
            } else if (!r.ok) {
                networkErr = new Error(`HTTP ${r.status}`);
            } else {
                html = await r.text();
                if (isRateLimitedHtml(html)) {
                    rateLimited = true;
                    html = null;
                }
            }
        } catch (e) {
            networkErr = e;
        }

        if (html) return html;

        // Page-context fetch didn't give us usable HTML. Try the service worker
        // fetch which sends an explicit Referer + UA and has full host
        // permissions.
        try {
            const bgHtml = await bgFetchPostHtml(url);
            if (bgHtml && !isRateLimitedHtml(bgHtml)) return bgHtml;
            // Treat rate-limit-page response as a 429.
            rateLimited = rateLimited || isRateLimitedHtml(bgHtml || '');
        } catch (e) {
            if (e && e.status === 429) rateLimited = true;
            else if (e && e.status === 403) forbidden = true;
            else if (!networkErr) networkErr = e;
        }

        if (rateLimited || forbidden) {
            const backoff = backoffForAttempt(attempt);
            // 429 throttles the whole pool; 403 only throttles this caller.
            if (rateLimited) bumpRateLimit(backoff);
            if (attempt >= MAX_FETCH_ATTEMPTS) {
                throw new Error(rateLimited ? `rate limited (429) after ${attempt} retries` : `forbidden (403) after ${attempt} retries`);
            }
            await delay(backoff);
            return fetchPostHtml(postId, attempt + 1);
        }

        if (attempt < MAX_FETCH_ATTEMPTS) {
            await delay(backoffForAttempt(attempt));
            return fetchPostHtml(postId, attempt + 1);
        }
        throw networkErr || new Error(`HTTP ${status || 'unknown'}`);
    }

    // Persistent URL cache — survives page reloads & browser restarts. Built
    // lazily; reads/writes hit chrome.storage.local. Cuts re-resolution costs
    // to zero for previously-downloaded posts and makes retries instant.
    let _urlCacheMem = null;
    async function loadUrlCache() {
        if (_urlCacheMem) return _urlCacheMem;
        const raw = await storageGet(STORAGE_KEY_CACHE, {});
        _urlCacheMem = (raw && typeof raw === 'object') ? raw : {};
        return _urlCacheMem;
    }
    function persistUrlCache() {
        if (!_urlCacheMem) return;
        // Evict expired + cap size.
        const now = Date.now();
        const entries = Object.entries(_urlCacheMem).filter(([_, v]) => v && v.url && v.ts && (now - v.ts) < URL_CACHE_TTL_MS);
        entries.sort((a, b) => b[1].ts - a[1].ts);
        const trimmed = entries.slice(0, URL_CACHE_LIMIT);
        _urlCacheMem = Object.fromEntries(trimmed);
        storageSet(STORAGE_KEY_CACHE, _urlCacheMem);
    }
    async function cacheGet(id) {
        const cache = await loadUrlCache();
        const v = cache[String(id)];
        if (!v || !v.url) return null;
        if (Date.now() - (v.ts || 0) > URL_CACHE_TTL_MS) return null;
        if (!isValidMediaUrl(v.url)) return null;
        return v.url;
    }
    async function cacheSet(id, url) {
        if (!isValidMediaUrl(url)) return;
        const cache = await loadUrlCache();
        cache[String(id)] = { url, ts: Date.now() };
        persistUrlCache();
    }

    const fileUrlInflight = new Map();
    function fetchPostFileUrl(postId) {
        const key = String(postId);
        if (fileUrlInflight.has(key)) return fileUrlInflight.get(key);

        const p = (async () => {
            // 1. Persistent cache hit
            const cached = await cacheGet(key);
            if (cached) return cached;

            // 2. Try HTML page (most reliable — has "Original image" link)
            let fileUrl = null;
            let htmlErr = null;
            try {
                const html = await fetchPostHtml(key);
                const doc = new DOMParser().parseFromString(html, 'text/html');
                fileUrl = findFileUrlInDoc(doc);
                if (!fileUrl) htmlErr = new Error('source URL not found on post page');
            } catch (e) {
                htmlErr = e;
            }

            // 3. Fall back to the JSON API via the service worker. Uses a
            //    different endpoint (api.rule34.xxx / dapi) which has its own
            //    rate budget, so it succeeds when the HTML route is blocked.
            if (!fileUrl) {
                try {
                    const resp = await bgFetchPostJson(key);
                    if (resp && resp.url && isValidMediaUrl(resp.url)) {
                        fileUrl = resp.url;
                    }
                } catch (apiErr) {
                    if (htmlErr) throw htmlErr;
                    throw apiErr;
                }
            }

            if (!fileUrl) throw (htmlErr || new Error('source URL not found'));
            if (!isValidMediaUrl(fileUrl)) throw new Error(`refusing non-media URL: ${fileUrl}`);

            await cacheSet(key, fileUrl);
            return fileUrl;
        })().finally(() => {
            fileUrlInflight.delete(key);
        });

        fileUrlInflight.set(key, p);
        return p;
    }

    // ------------------------------------------------------------------
    // Easy-select state — persisted via chrome.storage.local
    //   easy = true  → clicking anywhere on a thumbnail enqueues it for
    //                  download (no need to aim at the small DW button)
    //   easy = false → only the DW button enqueues; the rest of the thumb
    //                  behaves like a normal link to the post page
    // ------------------------------------------------------------------

    const EasyState = {
        easy: false,
        listeners: [],

        async init() {
            this.easy = !!(await storageGet(STORAGE_KEY_EASY, false));
            this.applyBodyClass();
            this.notify();
            this._installStorageSync();
        },

        _installStorageSync() {
            try {
                if (!ext || !ext.storage || !ext.storage.onChanged) return;
                ext.storage.onChanged.addListener((changes, area) => {
                    if (area !== 'local') return;
                    if (changes[STORAGE_KEY_EASY]) {
                        const v = !!changes[STORAGE_KEY_EASY].newValue;
                        if (v !== this.easy) {
                            this.easy = v;
                            this.applyBodyClass();
                            this.notify();
                        }
                    }
                });
            } catch (_) { /* ignore */ }
        },

        set(on) {
            on = !!on;
            if (this.easy === on) return;
            this.easy = on;
            storageSet(STORAGE_KEY_EASY, on);
            this.applyBodyClass();
            this.notify();
        },
        applyBodyClass() {
            const b = document.body;
            if (!b) return;
            b.classList.toggle('r34dw-easyselect', this.easy);
        },
        on(fn) { this.listeners.push(fn); },
        notify() { for (const fn of this.listeners) try { fn(); } catch (_) {} }
    };

    // ------------------------------------------------------------------
    // Persistent download queue — FIFO list of post IDs.
    //
    // Anatomy:
    //   - storage.local[QUEUE]   = ordered array of post IDs waiting to be
    //                              processed (the head is processed next)
    //   - storage.local[LOCK]    = {tab, ts} — only the lock-holder may pop
    //                              and process items. The active worker
    //                              refreshes ts every LOCK_REFRESH_MS so other
    //                              tabs see it as alive. If a tab is closed
    //                              mid-download, the lock simply goes stale
    //                              (no heartbeat) and another tab can grab it.
    //   - active (in-memory)     = id currently being processed in this tab,
    //                              shown in the toolbar as the active download
    //
    // The queue is NEVER cleared automatically; only successful downloads
    // remove their own ID. Failed items are dropped from the queue too
    // (the user is notified) — they're not auto-retried, the user can click
    // again if they want.
    // ------------------------------------------------------------------

    const DownloadQueue = {
        pending: [],          // ordered list of post IDs (strings)
        active: null,         // id currently being processed by THIS tab
        activeFilename: null, // filename of the active download, once resolved
        lastError: null,      // {id, message, ts} — most recent failure, for UI
        listeners: [],
        _suppressPersist: false,

        async init() {
            const stored = await storageGet(STORAGE_KEY_QUEUE, []);
            this.pending = (Array.isArray(stored) ? stored : []).map(String);
            this._installStorageSync();
            this.notify();
        },

        _installStorageSync() {
            try {
                if (!ext || !ext.storage || !ext.storage.onChanged) return;
                ext.storage.onChanged.addListener((changes, area) => {
                    if (area !== 'local') return;
                    if (changes[STORAGE_KEY_QUEUE]) {
                        const v = changes[STORAGE_KEY_QUEUE].newValue;
                        const arr = Array.isArray(v) ? v.map(String) : [];
                        const same = arr.length === this.pending.length
                                  && arr.every((id, i) => id === this.pending[i]);
                        if (!same) {
                            this._suppressPersist = true;
                            this.pending = arr;
                            this._suppressPersist = false;
                            this.notify();
                        }
                    }
                });
            } catch (_) { /* ignore */ }
        },

        _persist() {
            if (this._suppressPersist) return;
            try { storageSet(STORAGE_KEY_QUEUE, this.pending); } catch (_) {}
        },

        // Enqueue an id. Returns true if the queue actually changed, false if
        // the id was already pending/active (we silently dedupe so spamming
        // the same thumb doesn't create duplicate downloads).
        enqueue(id) {
            id = String(id);
            if (this.active === id) return false;
            if (this.pending.includes(id)) return false;
            this.pending.push(id);
            this._persist();
            this.notify();
            return true;
        },

        // Peek the head of the queue without removing it. Caller is expected
        // to hold the lock before processing it. We deliberately do NOT shift
        // here so that if the page navigates mid-processing, the item stays
        // at the head of pending and the next page-load resumes it.
        peekHead() {
            return this.pending.length === 0 ? null : this.pending[0];
        },

        // Remove a specific id from pending (typically called after the
        // download has been submitted to the service worker, success or fail).
        // Idempotent.
        removeId(id) {
            id = String(id);
            const i = this.pending.indexOf(id);
            if (i === -1) return false;
            this.pending.splice(i, 1);
            this._persist();
            this.notify();
            return true;
        },

        markActive(id, filename) {
            this.active = id ? String(id) : null;
            this.activeFilename = filename || null;
            this.notify();
        },

        markError(id, message) {
            this.lastError = { id: String(id), message: String(message || 'error'), ts: Date.now() };
            this.notify();
            // Clear the surfaced error after a few seconds so it doesn't get
            // stuck in the toolbar forever.
            setTimeout(() => {
                if (this.lastError && this.lastError.ts && Date.now() - this.lastError.ts >= 4500) {
                    this.lastError = null;
                    this.notify();
                }
            }, 5000);
        },

        // Total work the user can still see in flight: head + tail.
        outstanding() {
            return this.pending.length + (this.active ? 1 : 0);
        },

        on(fn) { this.listeners.push(fn); },
        notify() { for (const fn of this.listeners) try { fn(); } catch (_) {} }
    };

    // Lock primitives. We use chrome.storage.local with a heartbeat-style
    // timestamp. Storage writes inside the extension are serialized per key,
    // which is good enough for our 1-2 tab use case — a true CAS isn't needed.

    function lockGet() {
        return new Promise((resolve) => {
            try {
                ext.storage.local.get([STORAGE_KEY_LOCK], (out) => {
                    if (ext.runtime.lastError) { resolve(null); return; }
                    resolve((out && out[STORAGE_KEY_LOCK]) || null);
                });
            } catch (_) { resolve(null); }
        });
    }
    function lockWrite(lock) {
        return new Promise((resolve) => {
            try { ext.storage.local.set({ [STORAGE_KEY_LOCK]: lock }, () => resolve()); }
            catch (_) { resolve(); }
        });
    }
    function lockClear() {
        return new Promise((resolve) => {
            try { ext.storage.local.remove(STORAGE_KEY_LOCK, () => resolve()); }
            catch (_) { resolve(); }
        });
    }

    async function tryAcquireLock() {
        const now  = Date.now();
        const cur  = await lockGet();
        if (cur && cur.tab && cur.tab !== TAB_KEY && cur.ts && now - cur.ts < LOCK_TTL_MS) {
            return false; // someone else is actively working
        }
        await lockWrite({ tab: TAB_KEY, ts: now });
        // Double-check we still own it (a racing tab may have written between
        // our get & set). If not, back off — the loser of the race will retry.
        const after = await lockGet();
        return !!(after && after.tab === TAB_KEY);
    }

    async function refreshLock() {
        const cur = await lockGet();
        if (!cur || cur.tab !== TAB_KEY) return false;
        await lockWrite({ tab: TAB_KEY, ts: Date.now() });
        return true;
    }

    async function releaseLockIfHeld() {
        const cur = await lockGet();
        if (cur && cur.tab === TAB_KEY) await lockClear();
    }

    // Worker loop. Idempotent — calling it while it's already running is a
    // no-op. Persists across page navigations because the next page-load just
    // calls runQueueWorker() again and continues from the persisted queue.
    let _workerRunning = false;
    let _lockHeartbeat = null;

    async function runQueueWorker() {
        if (_workerRunning) return;
        if (DownloadQueue.pending.length === 0 && !DownloadQueue.active) return;
        _workerRunning = true;

        try {
            while (DownloadQueue.pending.length > 0) {
                const haveLock = await tryAcquireLock();
                if (!haveLock) {
                    // Another tab is actively processing. Sleep & re-check; if
                    // it dies the lock will go stale and we'll take over.
                    await delay(LOCK_REFRESH_MS);
                    continue;
                }

                if (!_lockHeartbeat) {
                    _lockHeartbeat = setInterval(() => { refreshLock(); }, LOCK_REFRESH_MS);
                }

                // Peek the head (don't shift yet). If the page dies while
                // we're working on this item, it stays at the head and the
                // next page-load resumes it.
                const id = DownloadQueue.peekHead();
                if (!id) break;
                DownloadQueue.markActive(id, null);

                try {
                    const url = await fetchPostFileUrl(id);
                    if (!isValidMediaUrl(url)) throw new Error('refusing non-media URL: ' + url);
                    const name = fileNameFromUrl(url);
                    DownloadQueue.markActive(id, name);
                    const r = await sendDownload(url, name);
                    if (!r || !r.ok) throw new Error((r && r.error) || 'download failed');
                    // Success: the only feedback is the toolbar counter going
                    // down. We deliberately don't toast every single file — a
                    // queue of 20 would spam the user.
                } catch (e) {
                    console.error('[Rule34 DW] queue item failed', id, e);
                    DownloadQueue.markError(id, e && e.message || e);
                    notify('Не удалось скачать пост ' + id, true, 2800);
                    // Treat failures as terminal too — not auto-retrying.
                    // The user can click the thumb again to re-enqueue.
                } finally {
                    // Only remove the item AFTER we've finished processing it
                    // (or given up). If the page died mid-processing, the
                    // `finally` doesn't run, the id stays at the head of
                    // pending, and the next page-load resumes it.
                    DownloadQueue.removeId(id);
                    DownloadQueue.markActive(null, null);
                }

                // Small inter-item delay so rule34 doesn't see an obvious
                // burst pattern. The URL cache already makes repeats instant.
                await delay(150);
            }
        } finally {
            _workerRunning = false;
            if (_lockHeartbeat) { clearInterval(_lockHeartbeat); _lockHeartbeat = null; }
            await releaseLockIfHeld();
        }
    }

    // Release the lock when the page goes away so the next tab/page doesn't
    // have to wait LOCK_TTL_MS for the heartbeat to expire.
    window.addEventListener('pagehide', () => { releaseLockIfHeld(); }, { capture: true });

    // ------------------------------------------------------------------
    // Compact toolbar — just the Easy-select toggle + a tiny queue counter.
    // Visible only on listing pages (hidden on individual post pages, where
    // the per-post floating DW button does the same job).
    // ------------------------------------------------------------------

    function buildToolbar() {
        if (document.getElementById('r34dw-toolbar')) return;
        if (isPostPage()) return;
        if (!document.body) return;

        const root = document.createElement('div');
        root.id = 'r34dw-toolbar';
        root.className = 'r34dw-toolbar';
        root.innerHTML = `
            <button type="button" class="r34dw-easy-toggle" role="switch" aria-checked="false"
                    title="Easy-select: тапнуть по работе = скачать (вкл/выкл)"
                    aria-label="Easy-select">
                <span class="r34dw-easy-box">
                    <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <polyline points="4 12 10 18 20 6"/>
                    </svg>
                </span>
                <span class="r34dw-easy-label">Easy</span>
            </button>
            <div class="r34dw-queue-status" aria-live="polite" hidden></div>
        `;
        document.body.appendChild(root);

        const easyToggle = root.querySelector('.r34dw-easy-toggle');
        const status     = root.querySelector('.r34dw-queue-status');

        easyToggle.addEventListener('click', () => EasyState.set(!EasyState.easy));

        const renderEasy = () => {
            easyToggle.classList.toggle('r34dw-active', !!EasyState.easy);
            easyToggle.setAttribute('aria-checked', EasyState.easy ? 'true' : 'false');
        };
        const renderQueue = () => {
            const outstanding = DownloadQueue.outstanding();
            if (DownloadQueue.lastError) {
                status.hidden = false;
                status.className = 'r34dw-queue-status r34dw-queue-error';
                status.textContent = `Ошибка ${DownloadQueue.lastError.id}`;
                return;
            }
            if (outstanding === 0) {
                status.hidden = true;
                status.className = 'r34dw-queue-status';
                status.textContent = '';
                return;
            }
            status.hidden = false;
            status.className = 'r34dw-queue-status r34dw-queue-active';
            // Show "Качаю Nк/M" where Nк is remaining-after-current. We display
            // just the outstanding count to keep it short on phones.
            status.textContent = `Качаю · ${outstanding}`;
        };

        EasyState.on(renderEasy);
        DownloadQueue.on(renderQueue);
        renderEasy();
        renderQueue();
    }

    // ------------------------------------------------------------------
    // Thumbnail listing: DW button + multi-select checkbox + easy-select
    // ------------------------------------------------------------------

    function postIdFromThumb(span) {
        if (span.id && /^s\d+$/.test(span.id)) return span.id.slice(1);
        const a = span.querySelector('a[id^="p"]');
        if (a && /^p\d+$/.test(a.id)) return a.id.slice(1);
        if (a && a.href) {
            const m = a.href.match(/[?&]id=(\d+)/);
            if (m) return m[1];
        }
        return null;
    }

    // Enqueue + start worker. Wrapped in a function so the per-thumb button
    // and the easy-mode click handler share the exact same behaviour, including
    // the brief feedback toast (only on the first item — after that the
    // toolbar counter is enough).
    function enqueueForDownload(id) {
        const added = DownloadQueue.enqueue(id);
        if (added) {
            // First click while idle → short toast. Subsequent clicks while a
            // download is already running keep silent (toolbar counter is
            // enough, otherwise we'd spam the user when they queue 10 items).
            if (DownloadQueue.outstanding() === 1) {
                notify('Качаю пост ' + id, false, 1500);
            }
        }
        // Always kick the worker — it's a no-op if already running, and it
        // also handles the "workers from previous page died mid-queue" case.
        runQueueWorker();
    }

    function addThumbControls(span) {
        if (!span || span.dataset.r34dw === '1') return;
        const id = postIdFromThumb(span);
        if (!id) return;
        span.dataset.r34dw = '1';
        span.classList.add('r34dw-thumb-wrap');
        const cs = getComputedStyle(span);
        if (cs.position === 'static') span.style.position = 'relative';

        // Small DW button in the top-right of the thumb. Clicking it enqueues
        // the post for download (one click → one download). The button stays
        // visible — no "loading" state — because downloads now happen via the
        // persistent queue and the toolbar counter is the canonical progress
        // indicator.
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'r34dw-btn r34dw-thumb-btn';
        btn.textContent = BTN_LABEL;
        btn.title = 'Скачать оригинал (поставить в очередь)';
        btn.setAttribute('aria-label', 'Скачать пост ' + id);

        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            enqueueForDownload(id);
        });
        btn.addEventListener('mousedown',  (e) => e.stopPropagation());
        btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

        span.appendChild(btn);

        // Easy-select: clicking anywhere on the thumb enqueues the post for
        // download. The body.r34dw-easyselect class gates whether we hijack the
        // click — when easy is off, the thumb keeps its native "click to open
        // post page" behaviour and only the DW button enqueues.
        const easyClickHandler = (ev) => {
            if (!EasyState.easy) return;
            const t = ev.target;
            if (t && t.closest && t.closest('.r34dw-thumb-btn')) return;
            ev.preventDefault();
            ev.stopPropagation();
            enqueueForDownload(id);
        };
        span.addEventListener('click', easyClickHandler, true);
        // Suppress the underlying <a>'s native navigation on mousedown in easy
        // mode — some browsers fire navigation before our click handler runs.
        span.addEventListener('mousedown', (ev) => {
            if (!EasyState.easy) return;
            const t = ev.target;
            if (t && t.closest && t.closest('.r34dw-thumb-btn')) return;
            // Middle-click and modifiers should still work for power users.
            if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
            ev.preventDefault();
        }, true);

        // Briefly highlight the thumb when its post becomes the active
        // download (so the user can see what's currently being fetched).
        const sync = () => {
            const isActive = DownloadQueue.active === id;
            span.classList.toggle('r34dw-thumb-active', isActive);
        };
        DownloadQueue.on(sync);
        sync();
    }

    function processThumbs(root) {
        const scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('span.thumb').forEach(addThumbControls);
    }

    // ------------------------------------------------------------------
    // Individual post page button
    // ------------------------------------------------------------------

    function isPostPage() {
        const u = location.search || '';
        return /[?&]page=post(?:&|$)/.test(u) && /[?&]s=view(?:&|$)/.test(u);
    }

    function findPostFileUrlOnPage() {
        return findFileUrlInDoc(document);
    }

    function addPostPageButton() {
        if (document.getElementById('r34dw-post-btn')) return;
        if (!isPostPage()) return;
        const initialUrl = findPostFileUrlOnPage();
        if (!initialUrl) return;

        const btn = document.createElement('button');
        btn.id = 'r34dw-post-btn';
        btn.type = 'button';
        btn.className = 'r34dw-btn r34dw-post-btn';
        btn.textContent = BTN_LABEL;
        btn.title = 'Скачать оригинал';
        btn.setAttribute('aria-label', 'Скачать оригинал');

        btn.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (btn.classList.contains('r34dw-loading')) return;
            btn.classList.add('r34dw-loading');
            const original = btn.textContent;
            btn.textContent = '…';
            try {
                const u = findPostFileUrlOnPage() || initialUrl;
                if (!isValidMediaUrl(u)) throw new Error('non-media URL on post page');
                const name = fileNameFromUrl(u);
                notify('Скачиваю: ' + name);
                const r = await sendDownload(u, name);
                if (!r || !r.ok) notify('Ошибка при скачивании', true, 3500);
            } catch (e) {
                console.error('[Rule34 DW]', e);
                notify('Ошибка при скачивании', true);
            } finally {
                btn.classList.remove('r34dw-loading');
                btn.textContent = original;
            }
        });

        document.body.appendChild(btn);
    }

    // ------------------------------------------------------------------
    // Boot + dynamic content (infinite scroll, AJAX page changes)
    // ------------------------------------------------------------------

    async function boot() {
        await Promise.all([
            EasyState.init(),
            DownloadQueue.init(),
        ]);
        buildToolbar();
        processThumbs(document);
        addPostPageButton();
        // Resume any leftover work from a prior page navigation. If the
        // queue is empty this is a no-op.
        runQueueWorker();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches && node.matches('span.thumb')) {
                    addThumbControls(node);
                } else if (node.querySelectorAll) {
                    const inner = node.querySelectorAll('span.thumb');
                    if (inner.length) inner.forEach(addThumbControls);
                }
            }
        }
        if (!document.getElementById('r34dw-post-btn')) addPostPageButton();
        if (!isPostPage() && !document.getElementById('r34dw-toolbar')) buildToolbar();
    });
    try {
        observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch (_) { /* ignore */ }
})();
