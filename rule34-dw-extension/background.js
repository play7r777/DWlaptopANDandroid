// Service worker for the Rule34 DW extension.
// Handles silent downloads via chrome.downloads.download (saveAs: false →
// no per-file dialog, files go straight to the browser's Downloads folder).
//
// Also acts as a privileged fetch proxy: page-context fetches sometimes get
// 403'd by rule34's edge filters when the Referer isn't a rule34 page (e.g.
// after an SPA-style navigation that swapped the URL). The service worker
// can set the Referer explicitly via the declarativeNetRequest-friendly
// `Referer` header on the request init, bypassing those filters.

const SUBDIR = 'rule34';
const POST_REFERER = 'https://rule34.xxx/index.php?page=post&s=list';
const FILE_EXT_RE = /\.(png|jpe?g|gif|webm|mp4|webp)(?:\?|#|$)/i;
const PHP_PATH_RE = /\.php(?:\?|#|$)/i;

function isMediaUrl(url) {
    if (!url) return false;
    if (PHP_PATH_RE.test(url)) return false;
    return FILE_EXT_RE.test(url);
}

// Sanitize a string so chrome.downloads.download accepts it as a filename.
// Rules:
//   - no path separators except the single subdir prefix we add ourselves
//   - no leading dots, control chars, or characters reserved on Windows
//   - keep it under 200 chars to be safe
function sanitizeName(raw) {
    let name = String(raw || 'rule34_download');
    // Strip any directory segments the caller may have included.
    name = name.split(/[\\/]/).pop() || 'rule34_download';
    // Strip query/hash if the caller derived a filename from a URL.
    name = name.split('?')[0].split('#')[0];
    // Replace characters Windows / Chrome's downloads API doesn't allow.
    name = name.replace(/[\x00-\x1f<>:"|?*]/g, '_');
    // Collapse whitespace, trim leading dots/spaces.
    name = name.replace(/\s+/g, ' ').replace(/^[. ]+/, '').trim();
    if (!name) name = 'rule34_download';
    if (name.length > 200) name = name.slice(0, 200);
    return name;
}

function downloadOne({ url, filename }) {
    return new Promise((resolve) => {
        if (!url) { resolve({ ok: false, error: 'no url' }); return; }
        if (!isMediaUrl(url)) {
            // Refuse to download .php / non-media URLs — these were the
            // "качается .php" bug. We never want chrome.downloads to receive
            // anything except a CDN media file.
            resolve({ ok: false, error: 'refusing non-media url: ' + url });
            return;
        }
        const name = sanitizeName(filename);
        try {
            chrome.downloads.download(
                {
                    url,
                    filename: `${SUBDIR}/${name}`,
                    saveAs: false,
                    conflictAction: 'uniquify',
                },
                (downloadId) => {
                    if (chrome.runtime.lastError) {
                        resolve({ ok: false, error: String(chrome.runtime.lastError.message || chrome.runtime.lastError) });
                    } else if (typeof downloadId !== 'number') {
                        resolve({ ok: false, error: 'no downloadId' });
                    } else {
                        resolve({ ok: true, downloadId });
                    }
                }
            );
        } catch (e) {
            resolve({ ok: false, error: String(e && e.message || e) });
        }
    });
}

// Fetch with rule34 referer set — service-worker fetches don't carry the
// content script's page referer automatically. Explicitly setting it makes
// rule34's edge layer treat the request as a same-site navigation, which
// avoids most 403s.
async function fetchWithReferer(url) {
    return fetch(url, {
        credentials: 'include',
        cache: 'no-cache',
        redirect: 'follow',
        referrer: POST_REFERER,
        referrerPolicy: 'strict-origin-when-cross-origin',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
    });
}

// Pull a media URL out of rule34's XML/JSON dapi response.
// XML: <post file_url="..." ... />
// JSON: [{file_url, sample_url, preview_url, ...}]
function extractFileUrlFromXml(xml) {
    if (!xml) return null;
    const m = xml.match(/\bfile_url=["']([^"']+)["']/i);
    if (m && isMediaUrl(m[1])) return m[1];
    return null;
}
function extractFileUrlFromJson(json) {
    if (!json) return null;
    const arr = Array.isArray(json) ? json : (json.post ? (Array.isArray(json.post) ? json.post : [json.post]) : null);
    if (!arr || !arr.length) return null;
    const p = arr[0];
    if (!p || typeof p !== 'object') return null;
    const candidates = [p.file_url, p.fileUrl];
    for (const c of candidates) {
        if (c && isMediaUrl(c)) return c;
    }
    return null;
}

async function fetchPostJsonViaApi(postId) {
    // Try both endpoints. The www. host shares cookies with the listing page
    // and returns the JSON without captcha when the user is logged in or has
    // recent browse cookies. The api. host is a backup.
    const urls = [
        `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&id=${encodeURIComponent(postId)}&json=1`,
        `https://rule34.xxx/index.php?page=dapi&s=post&q=index&id=${encodeURIComponent(postId)}&json=1`,
        `https://rule34.xxx/index.php?page=dapi&s=post&q=index&id=${encodeURIComponent(postId)}`,
    ];

    let lastErr = null;
    for (const u of urls) {
        try {
            const r = await fetchWithReferer(u);
            if (r.status === 429 || r.status === 403) {
                lastErr = new Error(`HTTP ${r.status}`);
                lastErr.status = r.status;
                continue;
            }
            if (!r.ok) {
                lastErr = new Error(`HTTP ${r.status}`);
                lastErr.status = r.status;
                continue;
            }
            const text = await r.text();
            // CAPTCHA HTML response — skip.
            if (/CAPTCHA|<html/i.test(text) && text.length < 4000) {
                lastErr = new Error('captcha response');
                continue;
            }
            let url = null;
            if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
                try {
                    const j = JSON.parse(text);
                    url = extractFileUrlFromJson(j);
                } catch (_) { /* ignore */ }
            }
            if (!url) url = extractFileUrlFromXml(text);
            if (url) return { ok: true, url };
            lastErr = new Error('no file_url in api response');
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('api fetch failed');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'download') {
        downloadOne({ url: msg.url, filename: msg.filename }).then(sendResponse);
        return true; // keep the message channel open for the async sendResponse
    }

    if (msg.type === 'downloadMany') {
        // Sequential downloads with a small delay between each so the browser
        // doesn't choke on a giant burst. Reports progress back via sendResponse
        // once everything completes.
        (async () => {
            const items = Array.isArray(msg.items) ? msg.items : [];
            const results = [];
            for (const item of items) {
                const r = await downloadOne(item);
                results.push(r);
                await new Promise(res => setTimeout(res, 80));
            }
            sendResponse({
                ok: results.every(r => r.ok),
                total: results.length,
                successes: results.filter(r => r.ok).length,
                failures: results.filter(r => !r.ok).length,
                results,
            });
        })();
        return true;
    }

    if (msg.type === 'fetchPostHtml') {
        // Fallback fetch from the service worker. Has full host_permissions
        // granted by manifest, bypasses any page-level CSP, runs with the
        // user's cookies for rule34.xxx, and sets an explicit Referer.
        (async () => {
            try {
                const url = String(msg.url || '');
                if (!/^https?:\/\/(?:[a-z0-9-]+\.)?rule34\.xxx\//i.test(url)) {
                    sendResponse({ ok: false, error: 'url not allowed' });
                    return;
                }
                const r = await fetchWithReferer(url);
                const html = await r.text();
                if (r.status === 429) {
                    sendResponse({ ok: false, error: 'HTTP 429', status: 429, html });
                    return;
                }
                if (r.status === 403) {
                    sendResponse({ ok: false, error: 'HTTP 403', status: 403, html });
                    return;
                }
                if (!r.ok) {
                    sendResponse({ ok: false, error: `HTTP ${r.status}`, status: r.status });
                    return;
                }
                sendResponse({ ok: true, html, status: r.status });
            } catch (e) {
                sendResponse({ ok: false, error: String(e && e.message || e) });
            }
        })();
        return true;
    }

    if (msg.type === 'fetchPostJson') {
        (async () => {
            try {
                const id = String(msg.id || '').replace(/[^0-9]/g, '');
                if (!id) {
                    sendResponse({ ok: false, error: 'no id' });
                    return;
                }
                const out = await fetchPostJsonViaApi(id);
                sendResponse(out);
            } catch (e) {
                sendResponse({ ok: false, error: String(e && e.message || e), status: e && e.status });
            }
        })();
        return true;
    }

    if (msg.type === 'ping') {
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        return false;
    }

    return false;
});
