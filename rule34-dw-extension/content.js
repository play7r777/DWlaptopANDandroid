// Rule34 DW Button — content script.
//
// Runs on every page of rule34.xxx. Adds:
//   - a "DW" download button to every <span class="thumb"> in the listing
//   - a fixed bottom-right "DW" button on each individual post page
//   - a sticky Solo / Multi toggle in the listing (hidden on post pages),
//     where Multi swaps the DW buttons for empty checkboxes for bulk selection
//   - an "Easy-select" checkbox in the toolbar — when on, clicking anywhere on
//     a thumbnail selects/deselects it (no need to aim at the small box).
//
// Selection persists across pages, tabs, browser restarts, and successful
// downloads — it is ONLY cleared by the red "Снять выделение" button.
//
// Downloads go through the background service worker, which calls
// chrome.downloads.download({saveAs:false}) so the browser saves silently
// to the Downloads/rule34/ folder — no per-file dialog, even for bulk runs.

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Configuration & helpers
    // ------------------------------------------------------------------

    const BTN_LABEL = 'DW';
    const STORAGE_KEY_MODE     = 'r34dw_mode';       // 'solo' | 'multi'
    const STORAGE_KEY_SELECTED = 'r34dw_selected';   // string[] of post IDs
    const STORAGE_KEY_EASY     = 'r34dw_easyselect'; // boolean — easy-select mode
    const STORAGE_KEY_CACHE    = 'r34dw_urlcache';   // {id: {url, ts}} — resolved file URLs

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

    function sendDownloadMany(items) {
        return new Promise((resolve) => {
            try {
                ext.runtime.sendMessage({ type: 'downloadMany', items }, (resp) => {
                    if (ext.runtime.lastError) {
                        resolve({ ok: false, error: String(ext.runtime.lastError.message || ext.runtime.lastError) });
                        return;
                    }
                    resolve(resp || { ok: false });
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
    // Mode state (Solo / Multi + Easy-select) — persisted via chrome.storage.local
    // ------------------------------------------------------------------

    const ModeState = {
        current: 'solo',
        easy: false,
        selected: new Set(),
        listeners: [],
        // _internal flag so storage.onChanged doesn't loop back into a save
        _suppressPersist: false,

        async init() {
            const [storedMode, storedSel, storedEasy] = await Promise.all([
                storageGet(STORAGE_KEY_MODE, 'solo'),
                storageGet(STORAGE_KEY_SELECTED, []),
                storageGet(STORAGE_KEY_EASY, false),
            ]);
            this.current = storedMode === 'multi' ? 'multi' : 'solo';
            this.selected = new Set(Array.isArray(storedSel) ? storedSel.map(String) : []);
            this.easy = !!storedEasy;
            this.applyBodyClass();
            this.notify();
            this._installStorageSync();
        },

        _installStorageSync() {
            try {
                if (!ext || !ext.storage || !ext.storage.onChanged) return;
                ext.storage.onChanged.addListener((changes, area) => {
                    if (area !== 'local') return;
                    if (changes[STORAGE_KEY_MODE]) {
                        const v = changes[STORAGE_KEY_MODE].newValue;
                        const next = v === 'multi' ? 'multi' : 'solo';
                        if (next !== this.current) {
                            this.current = next;
                            this.applyBodyClass();
                            this.notify();
                        }
                    }
                    if (changes[STORAGE_KEY_EASY]) {
                        const v = !!changes[STORAGE_KEY_EASY].newValue;
                        if (v !== this.easy) {
                            this.easy = v;
                            this.applyBodyClass();
                            this.notify();
                        }
                    }
                    if (changes[STORAGE_KEY_SELECTED]) {
                        const v = changes[STORAGE_KEY_SELECTED].newValue;
                        const arr = Array.isArray(v) ? v.map(String) : [];
                        // Replace only if actually different to avoid pointless re-renders.
                        const sameSize = arr.length === this.selected.size;
                        const sameItems = sameSize && arr.every(id => this.selected.has(id));
                        if (!sameItems) {
                            this.selected = new Set(arr);
                            this._suppressPersist = true;
                            this.notify();
                            this._suppressPersist = false;
                        }
                    }
                });
            } catch (_) { /* ignore */ }
        },

        _persistSelected() {
            if (this._suppressPersist) return;
            try { storageSet(STORAGE_KEY_SELECTED, Array.from(this.selected)); } catch (_) {}
        },

        set(mode) {
            mode = mode === 'multi' ? 'multi' : 'solo';
            if (this.current === mode) return;
            this.current = mode;
            storageSet(STORAGE_KEY_MODE, mode);
            this.applyBodyClass();
            this.notify();
        },
        setEasy(on) {
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
            b.classList.toggle('r34dw-mode-multi', this.current === 'multi');
            b.classList.toggle('r34dw-mode-solo',  this.current === 'solo');
            b.classList.toggle('r34dw-easyselect', this.easy && this.current === 'multi');
        },
        toggleSelected(id) {
            id = String(id);
            if (this.selected.has(id)) this.selected.delete(id);
            else this.selected.add(id);
            this._persistSelected();
            this.notify();
        },
        clearSelected() {
            if (this.selected.size === 0) return;
            this.selected.clear();
            this._persistSelected();
            this.notify();
        },
        on(fn) { this.listeners.push(fn); },
        notify() { for (const fn of this.listeners) try { fn(); } catch (_) {} }
    };

    // ------------------------------------------------------------------
    // Toolbar (mode switcher + multi actions). Hidden on post pages.
    // ------------------------------------------------------------------

    function buildToolbar() {
        if (document.getElementById('r34dw-toolbar')) return;
        if (isPostPage()) return;
        if (!document.body) return;

        const root = document.createElement('div');
        root.id = 'r34dw-toolbar';
        root.className = 'r34dw-toolbar';
        root.innerHTML = `
            <div class="r34dw-toolbar-header">
                <div class="r34dw-toolbar-title">Rule34 DW</div>
                <button type="button" class="r34dw-easy-toggle" role="switch" aria-checked="false"
                        title="Easy-select: тапнуть по работе = выделить (вкл/выкл)"
                        aria-label="Easy-select">
                    <span class="r34dw-easy-box">
                        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5"
                             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polyline points="4 12 10 18 20 6"/>
                        </svg>
                    </span>
                    <span class="r34dw-easy-label">Easy</span>
                </button>
            </div>
            <div class="r34dw-mode-row">
                <button type="button" class="r34dw-mode-btn" data-mode="solo">Solo</button>
                <button type="button" class="r34dw-mode-btn" data-mode="multi">Multi</button>
            </div>
            <div class="r34dw-multi-actions">
                <button type="button" class="r34dw-action-btn r34dw-download-selected" disabled>
                    Скачать выбранные (0)
                </button>
                <button type="button" class="r34dw-action-btn r34dw-clear" disabled>
                    Снять выделение
                </button>
                <div class="r34dw-progress" style="display:none"></div>
            </div>
        `;
        document.body.appendChild(root);

        root.querySelectorAll('.r34dw-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => ModeState.set(btn.dataset.mode));
        });

        const dlBtn      = root.querySelector('.r34dw-download-selected');
        const clearBtn   = root.querySelector('.r34dw-clear');
        const progress   = root.querySelector('.r34dw-progress');
        const easyToggle = root.querySelector('.r34dw-easy-toggle');

        dlBtn.addEventListener('click', () => downloadSelected(dlBtn, progress));
        clearBtn.addEventListener('click', () => ModeState.clearSelected());
        easyToggle.addEventListener('click', () => ModeState.setEasy(!ModeState.easy));

        ModeState.on(() => {
            root.querySelectorAll('.r34dw-mode-btn').forEach(b => {
                b.classList.toggle('r34dw-active', b.dataset.mode === ModeState.current);
            });
            const n = ModeState.selected.size;
            dlBtn.textContent = `Скачать выбранные (${n})`;
            dlBtn.disabled    = n === 0;
            clearBtn.disabled = n === 0;
            easyToggle.classList.toggle('r34dw-active', !!ModeState.easy);
            easyToggle.setAttribute('aria-checked', ModeState.easy ? 'true' : 'false');
        });

        ModeState.applyBodyClass();
        ModeState.notify();
    }

    // Process up to `limit` items in parallel, returning ordered results.
    // Each result is {ok:true, value} or {ok:false, error}.
    async function processWithConcurrency(items, limit, fn) {
        const results = new Array(items.length);
        let nextIdx = 0;
        const workers = [];
        const n = Math.max(1, Math.min(limit, items.length));
        for (let w = 0; w < n; w++) {
            workers.push((async () => {
                while (true) {
                    const idx = nextIdx++;
                    if (idx >= items.length) return;
                    try {
                        results[idx] = { ok: true, value: await fn(items[idx], idx) };
                    } catch (e) {
                        results[idx] = { ok: false, error: e };
                    }
                }
            })());
        }
        await Promise.all(workers);
        return results;
    }

    async function downloadSelected(dlBtn, progressEl) {
        const ids = Array.from(ModeState.selected);
        if (ids.length === 0) return;

        dlBtn.disabled = true;
        progressEl.style.display = 'block';
        progressEl.textContent = `Получаю ссылки 0/${ids.length}…`;

        // Resolve URLs with a single worker — rule34 starts 429ing aggressively
        // above ~2 concurrent post-page fetches. The persistent URL cache makes
        // repeat batches near-instant, so this only feels slow on first runs.
        const okIds      = [];
        const items      = [];
        const failedIds  = [];
        let resolved     = 0;

        await processWithConcurrency(ids, 1, async (id) => {
            try {
                const url = await fetchPostFileUrl(id);
                if (!isValidMediaUrl(url)) {
                    throw new Error('refusing to download non-media URL: ' + url);
                }
                items.push({ url, filename: fileNameFromUrl(url), id: String(id) });
                okIds.push(String(id));
            } catch (e) {
                console.error('[Rule34 DW] resolve failed for', id, e);
                failedIds.push(String(id));
            } finally {
                resolved++;
                progressEl.textContent = `Получаю ссылки ${resolved}/${ids.length}…`;
            }
        });

        if (items.length === 0) {
            progressEl.textContent = `Не удалось получить ни одной ссылки (${ids.length} попыток)`;
            console.error('[Rule34 DW] all URL resolutions failed for ids:', ids);
            setTimeout(() => { progressEl.style.display = 'none'; }, 5000);
            dlBtn.disabled = false;
            // Keep selection intact so the user can retry.
            return;
        }

        progressEl.textContent = `Скачиваю ${items.length} файл(ов)…`;
        notify(`Скачиваю ${items.length} файл(ов)`, false, 1800);

        const result = await sendDownloadMany(items);

        const failedResolve  = ids.length - items.length;
        const failedDownload = result && typeof result.failures  === 'number' ? result.failures  : 0;
        const successes      = result && typeof result.successes === 'number' ? result.successes : 0;
        const totalFailed    = failedResolve + failedDownload;

        progressEl.textContent = totalFailed
            ? `Готово: ${successes} ок, ${totalFailed} ошибок (см. консоль)`
            : `Готово: скачано ${successes}`;
        setTimeout(() => { progressEl.style.display = 'none'; progressEl.textContent = ''; }, 4500);

        // IMPORTANT: do NOT auto-clear the selection. The selection is only
        // cleared by the explicit red "Снять выделение" button — successful
        // downloads keep the selection so the user can re-download or pivot.
        dlBtn.disabled = false;
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

    function addThumbControls(span) {
        if (!span || span.dataset.r34dw === '1') return;
        const id = postIdFromThumb(span);
        if (!id) return;
        span.dataset.r34dw = '1';
        span.classList.add('r34dw-thumb-wrap');
        const cs = getComputedStyle(span);
        if (cs.position === 'static') span.style.position = 'relative';

        // Solo: DW button
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'r34dw-btn r34dw-thumb-btn';
        btn.textContent = BTN_LABEL;
        btn.title = 'Скачать оригинал';
        btn.setAttribute('aria-label', 'Скачать пост ' + id);

        btn.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (btn.classList.contains('r34dw-loading')) return;
            btn.classList.add('r34dw-loading');
            btn.textContent = '…';
            try {
                const url = await fetchPostFileUrl(id);
                if (!isValidMediaUrl(url)) throw new Error('refusing non-media URL');
                const name = fileNameFromUrl(url);
                notify('Скачиваю: ' + name);
                const r = await sendDownload(url, name);
                if (!r || !r.ok) notify('Не удалось скачать файл', true, 3500);
            } catch (e) {
                console.error('[Rule34 DW]', e);
                notify('Не удалось получить ссылку на файл', true);
            } finally {
                btn.classList.remove('r34dw-loading');
                btn.textContent = BTN_LABEL;
            }
        });
        btn.addEventListener('mousedown',  (e) => e.stopPropagation());
        btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

        span.appendChild(btn);

        // Multi: checkbox
        const check = document.createElement('div');
        check.className = 'r34dw-thumb-check';
        check.setAttribute('role', 'checkbox');
        check.setAttribute('aria-checked', 'false');
        check.setAttribute('aria-label', 'Выделить пост ' + id);
        check.title = 'Выделить (multi-select)';
        check.dataset.id = id;
        check.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<polyline points="4 12 10 18 20 6" />' +
            '</svg>';

        check.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ModeState.toggleSelected(id);
        });
        check.addEventListener('mousedown',  (e) => e.stopPropagation());
        check.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

        span.appendChild(check);

        // Easy-select: clicking anywhere on the thumb toggles selection while
        // body.r34dw-easyselect is on. We attach the listener once on the span;
        // the body class gates whether it actually fires (we always run, but
        // bail out when not in easy mode).
        const easySelectHandler = (ev) => {
            if (!(ModeState.current === 'multi' && ModeState.easy)) return;
            // Don't hijack clicks on our own controls (DW button / checkbox).
            const t = ev.target;
            if (t && t.closest && (t.closest('.r34dw-thumb-btn') || t.closest('.r34dw-thumb-check'))) {
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            ModeState.toggleSelected(id);
        };
        span.addEventListener('click', easySelectHandler, true);
        // Suppress the underlying <a>'s native navigation on mousedown in easy
        // mode — some browsers fire navigation before our click handler.
        span.addEventListener('mousedown', (ev) => {
            if (!(ModeState.current === 'multi' && ModeState.easy)) return;
            const t = ev.target;
            if (t && t.closest && (t.closest('.r34dw-thumb-btn') || t.closest('.r34dw-thumb-check'))) return;
            // Middle-click and modifiers should still work for power users.
            if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
            ev.preventDefault();
        }, true);

        const sync = () => {
            const isSel = ModeState.selected.has(id);
            check.classList.toggle('r34dw-checked', isSel);
            check.setAttribute('aria-checked', isSel ? 'true' : 'false');
            span.classList.toggle('r34dw-thumb-selected', isSel);
        };
        ModeState.on(sync);
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
        await ModeState.init();
        buildToolbar();
        processThumbs(document);
        addPostPageButton();
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
