/*
    Ctrl+V 截图秒传路过图床 —— Chrome 扩展版（content script，isolated world）

    上传只有一条通道：某个真正的 imgchr.com 文档自己发同源请求。

    在其他网站上按 Ctrl+V 时，图片不跨站发送，而是 chrome.runtime.sendMessage 交给后台，
    后台按需拉起一个隐藏的 offscreen 文档（内嵌不可见的 imgchr iframe），由那个 iframe 里
    的执行脚本（imgchr-frame.js）完成上传，结果原路返回。不需要打开任何 imgchr 标签页；
    token 和登录 cookie 一步都不离开 imgchr 的文档。

    刻意不做的事：抓 imgchr 首页、把一次性的 auth_token 抠出来跨站重放。那是 CSRF 防护，
    绕开它等于破解站方的安全控制，即使是给自己的账号传图也不行。也不依赖 API key ——
    实测这个账号领不到 key。

    与更早的油猴版（Tampermonkey 脚本 clip2img.user.js）逻辑一致，只换了三层：
      GM_getValue/GM_setValue  ->  chrome.storage.local（启动读入内存，onChanged 跨标签同步）
      GM_xmlhttpRequest        ->  同源 fetch（仅 imgchr 页面内）+ 后台隐藏通道转发
      unsafeWindow.PF          ->  不再需要：同源页面上读 auth_token 输入框/自己的 HTML
*/

(function () {
    'use strict';

    if (window.__clipvImgBedExt) return;
    window.__clipvImgBedExt = true;

    // 用户可见文案全部走 _locales（浏览器语言 zh→中文，en→英文）。
    var M = function (key, args) {
        try { return chrome.i18n.getMessage(key, args) || ''; } catch (e) { return ''; }
    };

    var HOST_ORIGIN = 'https://imgchr.com';
    var HOST_HOME = HOST_ORIGIN + '/';
    var HOST_JSON = HOST_ORIGIN + '/json';
    var HOST_LOGIN = HOST_ORIGIN + '/login';
    var IS_HOST = /(^|\.)imgchr\.com$/i.test(location.hostname);

    // imgchr /page/tos (rev. 2026-06-05): 60 uploads/hour, 5 MB per image for accounts.
    var RATE_MAX = 60;
    var RATE_WINDOW_MS = 3600 * 1000;
    var MAX_BYTES = 5 * 1024 * 1024;

    var TOS_SUMMARY = M('tosSummary');

    var FORMATS = {
        markdown: { label: M('fmtMarkdown'), build: function (l) { return '![' + l.title + '](' + l.direct + ')'; } },
        url:      { label: M('fmtUrl'), build: function (l) { return l.direct; } },
        viewer:   { label: M('fmtViewer'), build: function (l) { return l.viewer || l.direct; } },
        html:     { label: M('fmtHtml'), build: function (l) { return '<img src="' + l.direct + '" alt="' + l.title + '">'; } },
        bbcode:   { label: M('fmtBbcode'), build: function (l) { return '[img]' + l.direct + '[/img]'; } },
        thumbmd:  { label: M('fmtThumbMd'), build: function (l) { return '[![' + l.title + '](' + (l.thumb || l.direct) + ')](' + (l.viewer || l.direct) + ')'; } }
    };

    /* ------------------------------------------------------------- settings */

    var KEEPS = {
        never: { label: M('keepNever'), hours: 0 },
        h1:    { label: M('keep1h'), hours: 1 },
        h6:    { label: M('keep6h'), hours: 6 },
        d1:    { label: M('keep1d'), hours: 24 },
        d7:    { label: M('keep7d'), hours: 168 }
    };

    var CFG = {
        apiKey: '',                 // 已废弃：跨站上传不再需要 key，保留字段只为兼容旧存储
        copyFormat: 'markdown',
        autoInsert: true,
        askKeep: true,
        keep: 'never',
        tosAccepted: false,
        deletes: [],
        uploads: []
    };

    function persist(keys) {
        var patch = {};
        keys.forEach(function (k) { patch[k] = CFG[k]; });
        try { chrome.storage.local.set(patch); } catch (e) { /* storage unavailable */ }
    }

    function settings() {
        return {
            copyFormat: FORMATS[CFG.copyFormat] ? CFG.copyFormat : 'markdown',
            autoInsert: CFG.autoInsert !== false,
            askKeep: CFG.askKeep !== false,
            keep: KEEPS[CFG.keep] ? CFG.keep : 'never',
            tosAccepted: CFG.tosAccepted === true
        };
    }

    /* ----------------------------------------------------------- rate limit */

    function rateAllowed(record) {
        var now = Date.now();
        var hits = (CFG.uploads || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
        if (hits.length >= RATE_MAX) {
            CFG.uploads = hits; persist(['uploads']);
            return { ok: false, waitMin: Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 60000), used: hits.length };
        }
        if (record) { hits.push(now); }
        CFG.uploads = hits; persist(['uploads']);
        return { ok: true, used: hits.length };
    }

    /* ------------------------------------------------------------ transport */

    function parseHostJson(text, status) {
        var j;
        try { j = JSON.parse(text); }
        catch (e) { throw new Error(M('errNonJson', [status])); }
        var img = j && j.image;
        if (!img || !(img.display_url || (img.url && /^https?:/i.test(img.url)))) {
            var err = j && j.error;
            var msg = (err && (err.message || err)) || (j && j.status_txt) || ('HTTP ' + status);
            throw new Error(typeof msg === 'string' ? msg : M('errUploadFailed'));
        }
        return img;
    }

    function buildLinks(img, file) {
        var direct = img.display_url || (img.image && img.image.url) || img.url;
        var viewer = img.url_viewer || (img.image && img.image.permalink) || null;
        var del = img.delete_url || (img.delete && img.delete.url) || null;
        return {
            direct: direct,
            viewer: viewer,
            thumb: (img.thumb && img.thumb.url) || (img.medium && img.medium.url) || null,
            title: String(img.title || img.name || (file && file.name) || 'image').replace(/[\[\]]/g, ''),
            size: img.size != null ? Number(img.size) : (file ? file.size : null),
            width: img.width, height: img.height,
            deleteUrl: typeof del === 'string' ? del : null
        };
    }

    function fileToDataUrl(file) {
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () { resolve(fr.result); };
            fr.onerror = function () { reject(new Error(M('errReadClipboard'))); };
            fr.readAsDataURL(file);
        });
    }

    // Chevereto's own upload form carries an `expiration` field; the page's select lists the
    // values this account may actually use, so ask the page instead of guessing.
    function supportedExpiration(hours) {
        if (!hours) return null;
        var sel = document.querySelector('select[name="form-expiration"]');
        if (!sel || !sel.options) return null;
        var want = hours >= 168 ? '1w' : (hours >= 24 ? '1d' : (hours + 'h'));
        var first = null;
        for (var i = 0; i < sel.options.length; i++) {
            var v = String(sel.options[i].value || '');
            if (!v || v === '0') continue;
            if (v === want) return v;
            if (!first) first = v;
        }
        return first;
    }

    // Channel 1: only while actually on imgchr.com. Same-origin, so the site's own session
    // and its CSRF token stay inside the boundary they were issued for.
    function uploadSameOrigin(file, hours) {
        if (hostLooksAnonymous()) {
            var anon = new Error(M('errNotLoggedInHost'));
            anon.code = 'NOT_LOGGED_IN';
            return Promise.reject(anon);
        }
        var exp = supportedExpiration(hours);
        return readPageToken().then(function (token) {
            var fd = new FormData();
            fd.append('source', file, file.name || 'clipboard.png');
            fd.append('type', 'file');
            fd.append('action', 'upload');
            if (exp) fd.append('expiration', exp);
            fd.append('auth_token', token);
            return fetch(HOST_JSON, {
                method: 'POST', body: fd, credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            });
        }).then(function (r) {
            return r.text().then(function (t) {
                var img = parseHostJson(t, r.status);
                img.__serverExpiration = exp || null;
                return img;
            });
        });
    }

    // Delete uses the same list-editor payload the site itself posts.
    function deleteOnHost(encodedId) {
        if (!encodedId) return Promise.reject(new Error(M('errMissingId')));
        return readPageToken().then(function (token) {
            var fd = new FormData();
            fd.append('action', 'delete');
            fd.append('single', 'true');
            fd.append('delete', 'image');
            fd.append('deleting[id]', encodedId);
            fd.append('auth_token', token);
            return fetch(HOST_JSON, {
                method: 'POST', body: fd, credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            });
        }).then(function (r) {
            return r.text().then(function (t) {
                // A 200 with an error body, or any non-200, is a failed deletion. Treating it
                // as success would silently drop the image from the queue and leave it uploaded.
                var j = null;
                try { j = JSON.parse(t); } catch (e) { }
                var code = j && (j.status_code != null ? j.status_code : null);
                if (!r.ok || (code != null && code !== 200)) {
                    var msg = (j && j.error && (j.error.message || j.error)) || (j && j.status_txt) || ('HTTP ' + r.status);
                    throw new Error(M('errDeleteFailed', [typeof msg === 'string' ? msg : r.status]));
                }
                return { ok: true };
            });
        });
    }

    var pageToken = null;

    function readPageToken() {
        var el = document.querySelector('input[name="auth_token"]');
        if (el && el.value) { pageToken = el.value; return Promise.resolve(pageToken); }
        if (pageToken) return Promise.resolve(pageToken);
        return fetch(HOST_HOME, { credentials: 'same-origin' }).then(function (r) { return r.text(); })
            .then(function (html) {
                // The page inlines `auth_token: "<sha>"` as a bare JS object key -- unquoted.
                var m = html.match(/auth_token["']?\s*[:=]\s*["']([0-9a-f]{16,})["']/i);
                if (!m) throw new Error(M('errNoAuthTokenHost'));
                pageToken = m[1];
                return pageToken;
            });
    }

    // The 登录 link only renders without a session, so this costs zero extra requests.
    function hostLooksAnonymous() {
        var links = document.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            if (/\/login\/?$/.test(a.pathname) && a.offsetParent !== null) return true;
        }
        return false;
    }

    function askRuntime(payload) {
        return new Promise(function (resolve, reject) {
            var handled = false;
            function fail(msg) {
                if (handled) return;
                handled = true;
                reject(new Error(msg));
            }
            try {
                chrome.runtime.sendMessage(payload, function (resp) {
                    if (handled) return;
                    handled = true;
                    var le = chrome.runtime.lastError;
                    if (le) { fail(M('errBgChannel', [le.message])); return; }
                    if (!resp) { fail(M('errNoBgResponse')); return; }
                    resolve(resp);
                });
            } catch (e) {
                fail(M('errCtxInvalid', [e.message]));
            }
        });
    }

    // Channel 2: from any other site. The bytes go to the service worker, which spins up a
    // hidden offscreen imgchr document and lets THAT do the upload, so the session cookie
    // and the CSRF token never leave the imgchr document. No visible tab involved.
    function uploadViaBackground(file, hours) {
        return fileToDataUrl(file).then(function (dataUrl) {
            return askRuntime({
                type: 'cvib-upload',
                dataUrl: dataUrl,
                name: file.name || 'clipboard.png',
                hours: hours || 0
            });
        }).then(function (resp) {
            if (!resp.ok) {
                var e = new Error(resp.error || M('errUploadFailed'));
                if (resp.code) e.code = resp.code;
                throw e;
            }
            return resp.result;
        });
    }

    function openOptionsPage() {
        try { chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------- scheduled deletion */

    function scheduleDelete(encodedId, hours) {
        if (!encodedId || !hours) return;
        var list = (CFG.deletes || []).concat([{ id: String(encodedId), at: Date.now() + hours * 3600000 }]);
        CFG.deletes = list;
        persist(['deletes']);
        banner(M('bannerScheduled', [hours]));
    }

    var DELETE_RETRY_MAX = 6;

    function runDueDeletes() {
        var list = CFG.deletes || [], now = Date.now();
        var due = list.filter(function (d) { return d.at <= now; });
        if (!due.length) return Promise.resolve(0);
        var future = list.filter(function (d) { return d.at > now; });
        CFG.deletes = future;
        persist(['deletes']);
        // Failures go back on the queue. Dropping them here would silently leave the image
        // on the account forever, which defeats the point of scheduling a deletion.
        return due.reduce(function (chain, d) {
            return chain.then(function (done) {
                return deleteOnHost(d.id).then(function () {
                    return done + 1;
                }).catch(function () {
                    if ((d.tries || 0) + 1 < DELETE_RETRY_MAX) {
                        future.push({ id: d.id, at: now + 10 * 60000, tries: (d.tries || 0) + 1 });
                    }
                    return done;
                });
            });
        }, Promise.resolve(0)).then(function (deleted) {
            CFG.deletes = future;
            persist(['deletes']);
            if (deleted) banner(M('bannerDeleted', [deleted]));
            return deleted;
        });
    }

    function banner(msg) {
        try { console.info(M('consoleTag') + ' ' + msg); } catch (e) { }
    }

    function upload(file, hours) { return IS_HOST ? hostUpload(file, hours) : uploadViaBackground(file, hours); }

    function hostUpload(file, hours) {
        return uploadSameOrigin(file, hours).then(function (img) {
            if (hours && !img.__serverExpiration) scheduleDelete(img.id_encoded || img.id, hours);
            return img;
        });
    }

    /* -------------------------------------------------------- paste targets */

    function inOurUi(node) {
        return !!(node && node.closest && node.closest('.cvib-root'));
    }

    function classifyTarget() {
        var el = document.activeElement;
        if (!el || !el.tagName || inOurUi(el)) return { kind: null, el: null };
        var tag = el.tagName.toUpperCase();
        if (tag === 'INPUT') {
            var t = (el.type || 'text').toLowerCase();
            if (t === 'file' || t === 'checkbox' || t === 'radio' || t === 'button' ||
                t === 'submit' || t === 'reset' || t === 'range' || t === 'color') return { kind: null, el: el };
            return { kind: 'plain', el: el };
        }
        if (tag === 'TEXTAREA') return { kind: 'plain', el: el };
        if (el.isContentEditable) return { kind: 'rich', el: el };
        return { kind: null, el: el };
    }

    function setNativeValue(el, value) {
        var proto = el.tagName.toUpperCase() === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) { d.set.call(el, value); } else { el.value = value; }
    }

    function fireInput(el, data) {
        try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: data }));
        } catch (e) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    function insertText(el, text) {
        el.focus();
        var cur = el.value || '';
        var a = el.selectionStart, b = el.selectionEnd;
        if (typeof a !== 'number' || typeof b !== 'number') { a = b = cur.length; }
        setNativeValue(el, cur.slice(0, a) + text + cur.slice(b));
        try { el.selectionStart = el.selectionEnd = a + text.length; } catch (e) { /* unsupported */ }
        fireInput(el, text);
    }

    function replaceText(el, from, to) {
        var cur = el.value || '';
        var i = cur.indexOf(from);
        if (i < 0) return false;
        setNativeValue(el, cur.slice(0, i) + to + cur.slice(i + from.length));
        fireInput(el, to);
        return true;
    }

    /* ------------------------------------------------------------ clipboard */

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
        }
        return legacyCopy(text);
    }

    function legacyCopy(text) {
        return new Promise(function (resolve, reject) {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-2000px;left:-2000px;opacity:0';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            ta.remove();
            ok ? resolve() : reject(new Error('clipboard unavailable'));
        });
    }

    /* -------------------------------------------------------------------- ui */

    var CSS = [
        '.cvib-root{position:fixed;z-index:2147483000;right:16px;bottom:16px;width:340px;font:12px/1.55 ' +
        '-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e6e8ee;background:#14161c;' +
        'border:1px solid #2a2f3a;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);' +
        'display:flex;flex-direction:column;overflow:hidden;max-height:70vh}',
        '.cvib-root.cvib-hide{display:none}',
        '.cvib-head{display:flex;align-items:center;gap:8px;padding:8px 11px;background:#1b1f28;border-bottom:1px solid #2a2f3a}',
        '.cvib-title{font-weight:600}',
        '.cvib-rate{margin-left:auto;color:#8b93a7;font-size:11px}',
        '.cvib-icobtn{background:none;border:0;color:#8b93a7;cursor:pointer;font-size:14px;padding:0 4px}',
        '.cvib-icobtn:hover{color:#fff}',
        '.cvib-body{overflow-y:auto;padding:10px 11px}',
        '.cvib-card{display:flex;gap:9px;padding:8px;margin-bottom:8px;background:#1b1f28;border:1px solid #262b36;border-radius:9px}',
        '.cvib-card.cvib-bad{border-color:#5a2a2a}',
        '.cvib-thumb{flex:0 0 44px;height:44px;border-radius:6px;background:#0d0f14 center/cover no-repeat;' +
        'display:flex;align-items:center;justify-content:center;color:#5a6070}',
        '.cvib-main{flex:1;min-width:0}',
        '.cvib-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.cvib-stage{color:#8b93a7;margin:1px 0 5px;white-space:normal}',
        '.cvib-stage.cvib-err{color:#ff8080}',
        '.cvib-stage.cvib-warn{color:#e0a33e}',
        '.cvib-chips{display:flex;flex-wrap:wrap;gap:4px}',
        '.cvib-chip{font-size:11px;padding:2px 7px;background:#232833;color:#cfd4e0;border:1px solid #313846;' +
        'border-radius:6px;cursor:pointer;line-height:1.5}',
        '.cvib-chip:hover{background:#2c3340;color:#fff}',
        '.cvib-chip.cvib-done{background:#3ecf8e;color:#08130d;border-color:#3ecf8e}',
        '.cvib-chip.cvib-key{border-color:#3ecf8e;color:#3ecf8e}',
        '.cvib-opts{display:flex;align-items:center;gap:6px;padding:8px 11px;border-top:1px solid #2a2f3a;' +
        'background:#1b1f28;color:#8b93a7}',
        '.cvib-sel{flex:1;background:#0d0f14;color:#e6e8ee;border:1px solid #2f3542;border-radius:6px;padding:3px 5px;font-size:11.5px}',
        '.cvib-input{width:100%;background:#0d0f14;color:#e6e8ee;border:1px solid #2f3542;border-radius:6px;padding:5px 7px;font-size:11.5px;box-sizing:border-box}',
        '.cvib-btn{background:#232833;color:#cfd4e0;border:1px solid #313846;border-radius:6px;padding:3px 9px;cursor:pointer;font-size:11.5px}',
        '.cvib-btn.cvib-go{background:#2b4a7a;border-color:#3a5f96;color:#fff}',
        '.cvib-note{font-size:11px;color:#8b93a7;margin:0 0 8px}'
    ].join('');

    var els = null, hideTimer = null, pinned = IS_HOST;

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function ensureUi() {
        if (els) return els;
        var st = document.createElement('style');
        st.textContent = CSS;
        document.documentElement.appendChild(st);

        var root = el('div', 'cvib-root' + (pinned ? '' : ' cvib-hide'));
        var head = el('div', 'cvib-head');
        head.appendChild(el('span', 'cvib-title', M('uiTitle')));
        var rate = el('span', 'cvib-rate');
        head.appendChild(rate);
        var gear = el('button', 'cvib-icobtn', '⚙');
        var min = el('button', 'cvib-icobtn', pinned ? '–' : '×');
        head.appendChild(gear); head.appendChild(min);

        var body = el('div', 'cvib-body');
        var opts = el('div', 'cvib-opts');
        var sel = el('select', 'cvib-sel');
        Object.keys(FORMATS).forEach(function (k) {
            var o = el('option', null, FORMATS[k].label); o.value = k; sel.appendChild(o);
        });
        sel.value = settings().copyFormat;
        sel.addEventListener('change', function () { CFG.copyFormat = this.value; persist(['copyFormat']); });

        var toggle = el('button', 'cvib-btn', pinned ? M('uiCollapse') : M('uiPin'));
        toggle.addEventListener('click', function () {
            pinned = !pinned;
            root.classList.remove('cvib-hide');
            min.textContent = pinned ? '–' : '×';
            this.textContent = pinned ? M('uiCollapse') : M('uiPin');
        });

        opts.appendChild(sel); opts.appendChild(toggle);
        root.appendChild(head); root.appendChild(body); root.appendChild(opts);
        document.documentElement.appendChild(root);

        gear.addEventListener('click', function () { showSettings(body); });
        min.addEventListener('click', function () {
            if (pinned) { body.innerHTML = ''; this.textContent = '×'; return; }
            root.classList.add('cvib-hide');
        });

        els = { root: root, body: body, rate: rate };
        return els;
    }

    function showRate() {
        var r = rateAllowed(false);
        els.rate.textContent = M('rateUsed', [r.used, RATE_MAX]);
        els.rate.title = M('rateTitle');
    }

    function keepPrompt(card) {
        var s = settings();
        if (!s.askKeep) return Promise.resolve(KEEPS[s.keep].hours);
        return new Promise(function (resolve) {
            var row = el('div', 'cvib-chips');
            row.appendChild(el('span', 'cvib-note', M('keepQuestion')));
            var settled = false;
            function settle(k) {
                if (settled) return;
                settled = true;
                if (row.parentNode) row.parentNode.removeChild(row);
                CFG.keep = k; persist(['keep']);
                resolve(KEEPS[k].hours);
            }
            Object.keys(KEEPS).forEach(function (k) {
                var b = el('button', 'cvib-chip' + (k === s.keep ? ' cvib-key' : ''), KEEPS[k].label);
                b.addEventListener('click', function () { settle(k); });
                row.appendChild(b);
            });
            var remember = el('button', 'cvib-chip', M('keepDontAsk'));
            remember.title = M('keepDontAskTip');
            remember.addEventListener('click', function () {
                CFG.askKeep = false; persist(['askKeep']); settle(CFG.keep || 'never');
            });
            row.appendChild(remember);
            els.body.insertBefore(row, els.body.firstChild);
            setTimeout(function () {
                if (settled) return;
                settled = true;
                if (row.parentNode) row.parentNode.removeChild(row);
                resolve(KEEPS[s.keep].hours);
            }, 30000);
        });
    }

    function showSettings(body) {
        body.innerHTML = '';
        var box = el('div');
        box.appendChild(el('p', 'cvib-note', IS_HOST ? M('settingsHostNote') : M('settingsGuestNote')));
        var row = el('div', 'cvib-chips');
        var keepBtn = el('button', 'cvib-btn', M('settingsDefaultKeep', [KEEPS[settings().keep].label]));
        keepBtn.title = M('settingsDefaultKeepTip');
        keepBtn.addEventListener('click', function () {
            var keys = Object.keys(KEEPS);
            CFG.keep = keys[(keys.indexOf(CFG.keep) + 1) % keys.length];
            persist(['keep']);
            this.textContent = M('settingsDefaultKeep', [KEEPS[CFG.keep].label]);
        });
        var askBtn = el('button', 'cvib-btn', settings().askKeep ? M('settingsAskOn') : M('settingsAskOff'));
        askBtn.addEventListener('click', function () {
            CFG.askKeep = !CFG.askKeep; persist(['askKeep']);
            this.textContent = CFG.askKeep ? M('settingsAskOn') : M('settingsAskOff');
        });
        var open = el('button', 'cvib-btn', IS_HOST ? M('settingsRelogin') : M('settingsLoginPage'));
        open.addEventListener('click', function () {
            if (IS_HOST) { location.href = HOST_LOGIN; return; }
            window.open(HOST_LOGIN, '_blank');
        });
        var pend = el('button', 'cvib-btn', M('settingsPending', [(CFG.deletes || []).length]));
        pend.title = M('settingsPendingTip');
        pend.addEventListener('click', function () {
            if (IS_HOST) { runDueDeletes(); }
            CFG.deletes = []; persist(['deletes']);
            this.textContent = M('settingsPending', [0]);
        });
        var tos = el('button', 'cvib-btn', M('settingsTos'));
        tos.addEventListener('click', function () { window.alert(TOS_SUMMARY); });
        row.appendChild(keepBtn); row.appendChild(askBtn); row.appendChild(open); row.appendChild(pend); row.appendChild(tos);
        box.appendChild(row);
        body.appendChild(box);
    }

    function addCard(file) {
        var e = ensureUi();
        clearTimeout(hideTimer);
        e.root.classList.remove('cvib-hide');
        showRate();

        var card = el('div', 'cvib-card');
        var thumb = el('div', 'cvib-thumb');
        var main = el('div', 'cvib-main');
        main.appendChild(el('div', 'cvib-name', (file.name || M('clipboardImage')) + ' · ' + fmtSize(file.size)));
        var stage = el('div', 'cvib-stage', M('stageWorking'));
        var chips = el('div', 'cvib-chips');
        main.appendChild(stage); main.appendChild(chips);
        card.appendChild(thumb); card.appendChild(main);
        e.body.insertBefore(card, e.body.firstChild);

        try {
            var u = URL.createObjectURL(file);
            thumb.style.backgroundImage = 'url("' + u + '")';
            setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
        } catch (err) { thumb.textContent = M('thumbLetter'); }

        return {
            stage: function (t, cls) { stage.textContent = t; stage.className = 'cvib-stage' + (cls ? ' cvib-' + cls : ''); },
            fail: function (m, warn) { this.stage(M('stageFailed', [m]), warn ? 'warn' : 'err'); card.classList.add('cvib-bad'); },
            chips: function (list) {
                chips.innerHTML = '';
                list.forEach(function (c) {
                    var b = el('button', 'cvib-chip' + (c.key ? ' cvib-key' : ''), c.label);
                    b.title = c.value || c.label;
                    b.addEventListener('click', function () {
                        if (c.act) { c.act(b); return; }
                        copyText(c.value).then(function () { flash(b); }).catch(function () { });
                    });
                    chips.appendChild(b);
                });
            },
            autoHide: function () {
                if (pinned) return;
                clearTimeout(hideTimer);
                hideTimer = setTimeout(function () { els.root.classList.add('cvib-hide'); }, 14000);
            }
        };
    }

    function flash(b) { b.classList.add('cvib-done'); setTimeout(function () { b.classList.remove('cvib-done'); }, 1200); }

    function fmtSize(n) {
        if (n == null) return '';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(2) + ' MB';
    }

    function ensureTos() {
        if (settings().tosAccepted) return true;
        var ok = window.confirm(M('tosConfirm', [TOS_SUMMARY]));
        if (ok) { CFG.tosAccepted = true; persist(['tosAccepted']); }
        return ok;
    }

    /* --------------------------------------------------------------- pipeline */

    function extractImages(dt) {
        var out = [], i, f;
        if (!dt) return out;
        if (dt.files) {
            for (i = 0; i < dt.files.length; i++) if (/^image\//i.test(dt.files[i].type)) out.push(dt.files[i]);
        }
        if (!out.length && dt.items) {
            for (i = 0; i < dt.items.length; i++) {
                if (dt.items[i].kind === 'file' && /^image\//i.test(dt.items[i].type)) {
                    f = dt.items[i].getAsFile();
                    if (f) out.push(f);
                }
            }
        }
        return out;
    }

    function editableContext(node) {
        for (var n = node; n;) {
            if (n.nodeType === 11 && n.host) { n = n.host; continue; }   // shadow root -> host
            if (n.nodeType === 1 && n.isContentEditable) return true;
            n = n.parentNode;
        }
        return false;
    }

    function deepActive(node) {
        while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
        return node;
    }

    function pasteInEditable(e) {
        // composedPath 只在事件派发期间可读，所以这个判断必须在监听器里同步做完。
        try {
            var path = e.composedPath ? e.composedPath() : null;
            for (var i = 0; path && i < path.length; i++) {
                var n = path[i];
                if (n && n.nodeType === 1 && n.isContentEditable) return true;
            }
        } catch (err) { /* ignore */ }
        return editableContext(e.target) || editableContext(deepActive(document.activeElement));
    }

    function onPasteObserved(e) {
        var files = extractImages(e.clipboardData);
        if (!files.length) return;                       // never touch text pastes
        // 监听挂在 window 捕获阶段、document_start 时注册，比任何页面脚本都早：先同步记下
        // 「事件目标是否落在富文本上下文里」；页面是否接管（preventDefault）要等它的
        // handler 跑完才知道，用 setTimeout 0 延后读。文件必须现在同步取出——异步后
        // clipboardData 会被浏览器清空。
        var rich = pasteInEditable(e);
        setTimeout(function () { decidePaste(e, files, rich); }, 0);
    }

    function decidePaste(e, files, richAtEvent) {
        // 页面自己接管了这次粘贴：全程退让，只看不动。
        if (e.defaultPrevented) return;
        // 富文本编辑器（或事件目标/当前焦点落在 contenteditable 上下文里）自己能收图，
        // 不干涉。两处都查，因为有些编辑器会在处理粘贴时把焦点挪走。
        if (richAtEvent || editableContext(deepActive(document.activeElement))) return;
        if (inOurUi(document.activeElement)) return;
        var target = classifyTarget();
        if (target.kind === 'rich') return;
        var field = target.kind === 'plain' ? target.el : null;
        files.forEach(function (f) { run(f, field); });
    }

    function onHostPaste(e) {
        var files = extractImages(e.clipboardData);
        if (!files.length) return;
        e.preventDefault();
        e.stopImmediatePropagation();                    // else Chevereto uploads it a second time
        files.forEach(function (f) { run(f, null); });
    }

    function run(file, field) {
        var card = addCard(file);

        if (file.size > MAX_BYTES) {
            card.fail(M('errTooLarge', [fmtSize(file.size), fmtSize(MAX_BYTES)]), true);
            card.autoHide(); return;
        }
        // 额度账本只在执行端记账：站内直传在这里记，跨站转发由 imgchr 执行脚本记。
        // 请求方这里只做只读预检，提前给出友好提示。
        var r = IS_HOST ? rateAllowed(true) : rateAllowed(false);
        if (!r.ok) {
            showRate();
            card.fail(M('errRateLimit', [r.waitMin]), true);
            card.autoHide(); return;
        }
        showRate();
        if (!ensureTos()) { card.fail(M('errTosNotAccepted'), true); card.autoHide(); return; }

        // Ask how long to keep it. Temporary screenshots should not squat in the account
        // forever, and imgchr's free tier has no per-image TTL for every value we offer.
        keepPrompt(card).then(function (hours) {
            card.stage(IS_HOST ? M('stageUploading') : M('stageUploadingBg'));
            return upload(file, hours);
        }).then(function (img) {
            var links = buildLinks(img, file);
            var fmt = FORMATS[settings().copyFormat] || FORMATS.markdown;
            var text = fmt.build(links);
            var md = FORMATS.markdown.build(links);

            card.stage(img.__cached
                ? M('stageCached')
                : M('prefixUploaded') + fmtSize(links.size) + (links.width ? ' · ' + links.width + '×' + links.height : ''));

            var actions = [
                { label: 'MD', value: md },
                { label: M('actDirect'), value: links.direct },
                { label: 'HTML', value: FORMATS.html.build(links) },
                { label: 'BBCode', value: FORMATS.bbcode.build(links) },
                { label: M('actViewer'), value: links.viewer || links.direct },
                { label: M('actThumb'), value: links.thumb || links.direct }
            ];
            if (links.deleteUrl) actions.push({ label: M('actDelete'), value: links.deleteUrl });

            var inserted = null;
            if (field && settings().autoInsert) {
                try { insertText(field, text); inserted = text; } catch (e) { inserted = null; }
                if (inserted) card.stage(M('prefixUploaded') + M('stageInserted', [fmt.label]));
            }
            if (!inserted) {
                copyText(text).then(function () {
                    card.stage(M('prefixUploaded') + M('stageCopied', [fmt.label]) + (field ? M('copiedInsertFailed') : ''));
                }).catch(function () {
                    card.stage(M('prefixUploaded') + M('stageCopyButtons'));
                });
            }

            // Some plain-text boxes want the image wrapped in markdown rather than a bare URL.
            if (inserted && md !== inserted) {
                actions.unshift({
                    label: M('actToMd'), key: true, act: function (b) {
                        if (replaceText(field, inserted, md)) { b.textContent = M('actChanged'); flash(b); }
                        else { b.textContent = M('actFieldChanged'); }
                    }
                });
            }
            // 反向切换：插了带嵌套的格式后想要裸链接，一键换成源文件直链。
            if (inserted && text !== links.direct) {
                actions.unshift({
                    label: M('actToDirect'), key: true, act: function (b) {
                        if (replaceText(field, inserted, links.direct)) { b.textContent = M('actChanged'); flash(b); }
                        else { b.textContent = M('actFieldChanged'); }
                    }
                });
            }

            card.chips(actions);
            card.autoHide();
        }).catch(function (err) {
            var m = err && err.message ? err.message : String(err);
            var code = err && err.code;
            if (/重复|duplicate|already|已上传/i.test(m)) {
                // 站方开了「拒绝重复上传」：同一张图连按两次 Ctrl+V 时会走到这里。
                card.fail(M('errDuplicate'), true);
            } else {
                card.fail(m, !!code);
            }
            if (code === 'NOT_LOGGED_IN') {
                card.chips([{ label: M('chipLogin'), value: HOST_LOGIN }]);
            }
            card.autoHide();
        });
    }

    /* ------------------------------------------------------------------ boot */

    function boot() {
        try {
            var ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
            console.info(M('consoleTag') + ' ' + (IS_HOST ? M('bootHost', [ver]) : M('bootGuest', [ver])));
        } catch (e) { /* diagnostics only */ }

        if (IS_HOST) {
            ensureUi();
            pinned = true;
            showRate();
            setInterval(function () { runDueDeletes().catch(function () { }); }, 60000);
            setTimeout(function () { runDueDeletes().catch(function () { }); }, 3000);
        }
    }

    // paste 监听必须在 document_start 同步注册（window 捕获阶段）：一是抢在任何页面脚本
    // 前面看到事件（页面可能 stopImmediatePropagation 拦掉它），二是「事件目标是否富文本」
    // 这类判断只有派发期间同步做才可靠；是否上传由 decidePaste 等页面处理完再定，
    // 上传依赖的配置晚一点由 storage 异步补上。
    try {
        window.addEventListener('paste', IS_HOST ? onHostPaste : onPasteObserved, true);
    } catch (e) { /* ignore */ }

    function start() {
        try {
            chrome.storage.local.get(null, function (stored) {
                if (stored && typeof stored === 'object') mergeConfig(stored);
                boot();
            });
            // Keep every open tab in sync: setting the key in one tab must apply to the rest
            // without a reload.
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== 'local' || !changes) return;
                mergeConfig(changes);
            });
        } catch (e) { boot(); }
    }

    function mergeConfig(src) {
        Object.keys(CFG).forEach(function (k) {
            var v = src[k] && src[k].newValue !== undefined ? src[k].newValue : src[k];
            if (v !== undefined) CFG[k] = v;
        });
    }

    start();   // document_start 就跑，不等 DOMContentLoaded；UI 需要的 DOM 都是懒创建
})();
