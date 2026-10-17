/*
    imgchr.com 执行端（content script，all_frames）。

    只在两种环境里存在：普通 imgchr 标签页（顶层窗口，什么都不做），以及后台 offscreen
    文档里那个隐藏 iframe（window.top !== window，真正干活）。上传、删除都在这里以 imgchr
    自己的同源身份发起，auth_token 和登录 cookie 全程留在 imgchr 的文档里，一步都不跨出去。

    刻意不做的事：把 auth_token 抠出来拿到别的源去重放。那是 CSRF 防护，绕开它等于破解
    站方的安全控制，即使是给自己的账号传图也不行。也不依赖 API key —— 实测这个账号领不到。
*/

(function () {
    'use strict';

    if (window.top === window) return;      // 普通 imgchr 标签页：本脚本不参与，直接退出

    // 用户可见文案走 _locales（浏览器语言 zh→中文，en→英文）。
    var M = function (key, args) {
        try { return chrome.i18n.getMessage(key, args) || ''; } catch (e) { return ''; }
    };

    var HOST_ORIGIN = 'https://imgchr.com';
    var HOST_HOME = HOST_ORIGIN + '/';
    var HOST_JSON = HOST_ORIGIN + '/json';
    var FRAME_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;

    // imgchr /page/tos (rev. 2026-06-05): 60 uploads/hour, 5 MB per image for accounts.
    var RATE_MAX = 60;
    var RATE_WINDOW_MS = 3600 * 1000;
    var MAX_BYTES = 5 * 1024 * 1024;
    var DELETE_RETRY_MAX = 6;

    var pageToken = null;
    var chain = Promise.resolve();

    window.addEventListener('message', function (e) {
        if (e.origin !== FRAME_ORIGIN || !e.data || e.data.source !== 'cvib-frame-in') return;
        var id = e.data.id, job = e.data.job;
        chain = chain.then(function () { return runJob(job); })
            .then(function (result) { reply(id, { ok: true, result: result }); })
            .catch(function (err) { reply(id, { ok: false, error: (err && err.message) || String(err), code: err && err.code }); });
    });

    function reply(id, payload) {
        payload.source = 'cvib-frame-out';
        payload.id = id;
        window.parent.postMessage(payload, FRAME_ORIGIN);
    }

    (function announce() {
        // 报告就绪。iframe 加载完成前 offscreen 会把任务排队。
        try { window.parent.postMessage({ source: 'cvib-frame-out', type: 'ready' }, FRAME_ORIGIN); }
        catch (e) { /* extension context gone */ }
    })();

    function runJob(job) {
        if (!job || !job.kind) return Promise.reject(new Error(M('errEmptyJob')));
        if (job.kind === 'upload') return doUpload(job);
        if (job.kind === 'delete-due') return doDueDeletes();
        return Promise.reject(new Error(M('errUnknownJob', [job.kind])));
    }

    /* ------------------------------------------------------------ storage */

    function storageGet(keys) {
        return new Promise(function (resolve) {
            try { chrome.storage.local.get(keys, function (o) { resolve(o || {}); }); }
            catch (e) { resolve({}); }
        });
    }

    function storageSet(patch) {
        return new Promise(function (resolve) {
            try { chrome.storage.local.set(patch, function () { resolve(); }); }
            catch (e) { resolve(); }
        });
    }

    // 额度账本只在真正执行上传的地方记账（这里），请求方只读不写，避免双份计数。
    function rateTick() {
        return storageGet(['uploads']).then(function (o) {
            var now = Date.now();
            var hits = (o.uploads || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
            if (hits.length >= RATE_MAX) {
                return storageSet({ uploads: hits }).then(function () {
                    throw err(M('errRateLimit', [Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 60000)]), 'RATE');
                });
            }
            hits.push(now);
            return storageSet({ uploads: hits });
        });
    }

    function err(message, code) {
        var e = new Error(message);
        if (code) e.code = code;
        return e;
    }

    /* ------------------------------------------------------- imgchr internals */

    function parseHostJson(text, status) {
        var j;
        try { j = JSON.parse(text); }
        catch (e) { throw new Error(M('errNonJsonDetail', [status, String(text).slice(0, 160)])); }
        var img = j && j.image;
        if (!img || !(img.display_url || (img.url && /^https?:/i.test(img.url)))) {
            var e2 = j && j.error;
            var msg = (e2 && (e2.message || e2)) || (j && j.status_txt) || ('HTTP ' + status);
            // 站方偶发把 error.message 放成对象；吞成「上传失败」会掩盖真实原因，原样带出去。
            if (typeof msg !== 'string') msg = JSON.stringify(e2 || j).slice(0, 300);
            throw new Error(msg);
        }
        return img;
    }

    function hashString(s) {
        var h = 5381;
        for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36) + ':' + s.length.toString(36);
    }

    // imgchr 开了「拒绝重复上传」：同一张剪贴板图连按两次 Ctrl+V 会被站方拒掉。
    // 本地记一张最近上传表，命中就直接复用已有链接，不重复打扰站方。
    var CACHE_MAX = 50;
    var SERVER_EXP_HOURS = { '1h': 1, '6h': 6, '1d': 24, '1w': 168 };

    function cacheGet(key) {
        return storageGet(['uploadCache']).then(function (o) {
            var hit = (o.uploadCache || {})[key];
            if (!hit) return null;
            var lifeHours = hit.expHours || Infinity;
            if (Date.now() - hit.at > lifeHours * 3600000) return null;
            return hit.img;
        });
    }

    function cachePut(key, img) {
        return storageGet(['uploadCache']).then(function (o) {
            var c = o.uploadCache || {};
            var bare = {};
            for (var k in img) if (k !== '__serverExpiration') bare[k] = img[k];
            c[key] = { img: bare, at: Date.now(), expHours: SERVER_EXP_HOURS[img.__serverExpiration] || null };
            var keys = Object.keys(c);
            if (keys.length > CACHE_MAX) {
                keys.sort(function (a, b) { return c[a].at - c[b].at; });
                keys.slice(0, keys.length - CACHE_MAX).forEach(function (k2) { delete c[k2]; });
            }
            return storageSet({ uploadCache: c });
        });
    }

    function dataUrlToFile(dataUrl, name) {
        var m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
        if (!m) throw new Error(M('errBadDataUrl'));
        var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return new File([u8], name || 'clipboard.png', { type: m[1] || 'image/png' });
    }

    function readPageToken() {
        var el = document.querySelector('input[name="auth_token"]');
        if (el && el.value) { pageToken = el.value; return Promise.resolve(pageToken); }
        if (pageToken) return Promise.resolve(pageToken);
        // 与页面同源，读自己的 HTML 属于站点内部行为；token 不离开 imgchr 的文档边界。
        return fetch(HOST_HOME, { credentials: 'same-origin' }).then(function (r) { return r.text(); })
            .then(function (html) {
                var m = html.match(/auth_token["']?\s*[:=]\s*["']([0-9a-f]{16,})["']/i);
                if (!m) throw new Error(M('errNoAuthTokenFrame'));
                pageToken = m[1];
                return pageToken;
            });
    }

    // 登录链接只在无会话时渲染，零额外请求。
    function hostLooksAnonymous() {
        var links = document.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            if (/\/login\/?$/.test(a.pathname) && a.offsetParent !== null) return true;
        }
        return false;
    }

    // Chevereto 自己的上传表单带 expiration 字段；页面下拉里列的是该账号真正可用的值。
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

    function postJson(fd) {
        return fetch(HOST_JSON, {
            method: 'POST', body: fd, credentials: 'same-origin',
            headers: { 'Accept': 'application/json' }
        }).then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); });
    }

    function doUpload(job) {
        var file;
        try { file = dataUrlToFile(job.dataUrl, job.name); }
        catch (e) { return Promise.reject(e); }
        if (file.size > MAX_BYTES) return Promise.reject(new Error(M('errTooLargeFrame')));
        var key = hashString(job.dataUrl);
        return cacheGet(key).then(function (cached) {
            if (cached) { cached.__cached = true; return cached; }
            if (hostLooksAnonymous()) {
                return Promise.reject(err(M('errNotLoggedInFrame'), 'NOT_LOGGED_IN'));
            }
            return rateTick().then(function () {
                var exp = supportedExpiration(job.hours);
                return readPageToken().then(function (token) {
                    var fd = new FormData();
                    fd.append('source', file, file.name || 'clipboard.png');
                    fd.append('type', 'file');
                    fd.append('action', 'upload');
                    if (exp) fd.append('expiration', exp);
                    fd.append('auth_token', token);
                    return postJson(fd);
                }).then(function (resp) {
                    var img = parseHostJson(resp.text, resp.status);
                    img.__serverExpiration = exp || null;
                    if (job.hours && !img.__serverExpiration) return scheduleDelete(img.id_encoded || img.id, job.hours).then(function () { return img; });
                    return img;
                }).then(function (img) {
                    return cachePut(key, img).then(function () { return img; });
                });
            });
        });
    }

    /* ------------------------------------------------- scheduled deletion */

    function scheduleDelete(encodedId, hours) {
        if (!encodedId || !hours) return Promise.resolve();
        return storageGet(['deletes']).then(function (o) {
            var list = (o.deletes || []).concat([{ id: String(encodedId), at: Date.now() + hours * 3600000 }]);
            return storageSet({ deletes: list });
        });
    }

    function deleteOnHost(encodedId) {
        if (!encodedId) return Promise.reject(new Error(M('errMissingId')));
        return readPageToken().then(function (token) {
            var fd = new FormData();
            fd.append('action', 'delete');
            fd.append('single', 'true');
            fd.append('delete', 'image');
            fd.append('deleting[id]', encodedId);
            fd.append('auth_token', token);
            return postJson(fd);
        }).then(function (resp) {
            // 200 带错误体或任何非 200 都是删除失败；当成成功会把图片永远留在账号上。
            var j = null;
            try { j = JSON.parse(resp.text); } catch (e) { }
            var code = j && (j.status_code != null ? j.status_code : null);
            if (!resp.status || resp.status < 200 || resp.status >= 300 || (code != null && code !== 200)) {
                var msg = (j && j.error && (j.error.message || j.error)) || (j && j.status_txt) || ('HTTP ' + resp.status);
                throw new Error(M('errDeleteFailed', [typeof msg === 'string' ? msg : resp.status]));
            }
            return { ok: true };
        });
    }

    function doDueDeletes() {
        return storageGet(['deletes']).then(function (o) {
            var list = o.deletes || [], now = Date.now();
            var due = list.filter(function (d) { return d.at <= now; });
            if (!due.length) return { deleted: 0 };
            var future = list.filter(function (d) { return d.at > now; });
            return due.reduce(function (ch, d) {
                return ch.then(function (done) {
                    return deleteOnHost(d.id).then(function () { return done + 1; }).catch(function () {
                        if ((d.tries || 0) + 1 < DELETE_RETRY_MAX) {
                            future.push({ id: d.id, at: Date.now() + 10 * 60000, tries: (d.tries || 0) + 1 });
                        }
                        return done;
                    });
                });
            }, Promise.resolve(0)).then(function (deleted) {
                return storageSet({ deletes: future }).then(function () { return { deleted: deleted }; });
            });
        });
    }
})();
