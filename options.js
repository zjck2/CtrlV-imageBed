'use strict';

(function () {
    var $ = function (id) { return document.getElementById(id); };
    var RATE_WINDOW_MS = 3600 * 1000;

    // 用户可见文案走 _locales（浏览器语言 zh→中文，en→英文）。
    var M = function (key, args) {
        try { return chrome.i18n.getMessage(key, args) || ''; } catch (e) { return ''; }
    };
    var KEEP_MSG = { never: 'keepNever', h1: 'keep1h', h6: 'keep6h', d1: 'keep1d', d7: 'keep7d' };
    var keepLabel = function (k) { return M(KEEP_MSG[k] || 'keepNever'); };

    // 静态文本：HTML 里标了 data-i18n 的元素在这里统一填入译文（含 title 属性）。
    document.title = M('optPageTitle');
    document.querySelectorAll('[data-i18n]').forEach(function (n) {
        var text = M(n.getAttribute('data-i18n'));
        if (text) n.textContent = text;
    });

    var current = {
        copyFormat: 'markdown', autoInsert: true, askKeep: true, keep: 'never',
        tosAccepted: false, deletes: [], uploads: []
    };

    function save(patch, note) {
        // Apply locally first: the page must reflect its own edits immediately rather than
        // waiting for a storage.onChanged round-trip.
        merge(patch);
        chrome.storage.local.set(patch, function () {
            if (note) flash(note);
            render();
        });
    }

    // Accepts both a plain {key:value} patch and a chrome.storage.onChanged
    // {key:{newValue:value}} map.
    function merge(src) {
        Object.keys(src).forEach(function (k) {
            if (!(k in current)) return;
            var v = (src[k] && typeof src[k] === 'object' && 'newValue' in src[k]) ? src[k].newValue : src[k];
            current[k] = v;
        });
    }

    var noteTimer = null;
    function flash(text) {
        var el = $('keepState');
        el.textContent = text;
        el.className = 'hint ok';
        clearTimeout(noteTimer);
        noteTimer = setTimeout(render, 2200);
    }

    function render(stored) {
        var s = stored || current;
        $('ver').textContent = chrome.runtime.getManifest().version;
        $('copyFormat').value = s.copyFormat || 'markdown';
        $('autoInsert').checked = s.autoInsert !== false;
        $('askKeep').checked = s.askKeep !== false;
        $('keep').value = KEEP_MSG[s.keep] ? s.keep : 'never';

        var pending = (s.deletes || []).length;
        $('delCount').textContent = pending;
        $('keepState').className = 'hint';
        $('keepState').textContent = (s.askKeep !== false)
            ? M('optAskOn')
            : M('optAskOff', [keepLabel(s.keep)]);

        var hits = (s.uploads || []).filter(function (t) { return Date.now() - t < RATE_WINDOW_MS; });
        $('rateUsed').textContent = hits.length;
        $('tosState').textContent = s.tosAccepted ? M('optTosOk') : M('optTosPending');
        $('tosState').className = s.tosAccepted ? 'ok' : 'bad';
    }

    chrome.storage.local.get(null, function (stored) {
        if (stored && typeof stored === 'object') {
            Object.keys(current).forEach(function (k) {
                if (stored[k] !== undefined) current[k] = stored[k];
            });
        }
        render();
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes) return;
        merge(changes);
        render();
    });

    $('copyFormat').addEventListener('change', function () {
        save({ copyFormat: this.value }, M('optSavedFormat'));
    });
    $('autoInsert').addEventListener('change', function () {
        save({ autoInsert: this.checked }, M('optSaved'));
    });
    $('askKeep').addEventListener('change', function () {
        save({ askKeep: this.checked }, M('optSaved'));
    });
    $('keep').addEventListener('change', function () {
        save({ keep: this.value }, M('optSavedKeep'));
    });
    $('clearDeletes').addEventListener('click', function () {
        save({ deletes: [] }, M('optQueueCleared'));
    });
    $('runDeletes').addEventListener('click', function () {
        var b = this;
        b.textContent = M('optRunning');
        chrome.runtime.sendMessage({ type: 'cvib-delete-due' }, function (resp) {
            var le = chrome.runtime.lastError;
            if (le) { b.textContent = M('optBgUnavailable'); return; }
            if (!resp || !resp.ok) { b.textContent = (resp && resp.error) || M('optBgChannel'); return; }
            b.textContent = M('optDeleted', [(resp.result && resp.result.deleted) || 0]);
            setTimeout(function () { b.textContent = M('optRunDue'); }, 2500);
        });
    });
    $('resetRate').addEventListener('click', function () {
        save({ uploads: [] }, M('optRateReset'));
    });
    $('resetTos').addEventListener('click', function () {
        save({ tosAccepted: false }, M('optTosReset'));
    });
})();
