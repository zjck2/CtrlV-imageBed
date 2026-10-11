'use strict';

(function () {
    var $ = function (id) { return document.getElementById(id); };
    var RATE_WINDOW_MS = 3600 * 1000;
    var KEEP_LABEL = {
        never: '永久保留', h1: '1 小时后删除', h6: '6 小时后删除', d1: '1 天后删除', d7: '7 天后删除'
    };

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
        $('keep').value = KEEP_LABEL[s.keep] ? s.keep : 'never';

        var pending = (s.deletes || []).length;
        $('delCount').textContent = pending;
        $('keepState').className = 'hint';
        $('keepState').textContent = (s.askKeep !== false)
            ? '每次上传都会问你留多久。'
            : '不再询问，按 Ctrl+V 一律「' + (KEEP_LABEL[s.keep] || '永久保留') + '」。';

        var hits = (s.uploads || []).filter(function (t) { return Date.now() - t < RATE_WINDOW_MS; });
        $('rateUsed').textContent = hits.length;
        $('tosState').textContent = s.tosAccepted ? '已确认' : '未确认（下次上传前会问你一次）';
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
        save({ copyFormat: this.value }, '格式已保存 ✓');
    });
    $('autoInsert').addEventListener('change', function () {
        save({ autoInsert: this.checked }, '已保存 ✓');
    });
    $('askKeep').addEventListener('change', function () {
        save({ askKeep: this.checked }, '已保存 ✓');
    });
    $('keep').addEventListener('change', function () {
        save({ keep: this.value }, '默认已保存 ✓');
    });
    $('clearDeletes').addEventListener('click', function () {
        save({ deletes: [] }, '待删队列已清空 ✓');
    });
    $('runDeletes').addEventListener('click', function () {
        var b = this;
        b.textContent = '执行中…';
        chrome.runtime.sendMessage({ type: 'cvib-delete-due' }, function (resp) {
            var le = chrome.runtime.lastError;
            if (le) { b.textContent = '后台不可用'; return; }
            if (!resp || !resp.ok) { b.textContent = (resp && resp.error) || '后台通道不可用'; return; }
            b.textContent = '已删除 ' + ((resp.result && resp.result.deleted) || 0) + ' 项';
            setTimeout(function () { b.textContent = '现在执行到期项'; }, 2500);
        });
    });
    $('resetRate').addEventListener('click', function () {
        save({ uploads: [] }, '计数已清零 ✓');
    });
    $('resetTos').addEventListener('click', function () {
        save({ tosAccepted: false }, '已重置，下次上传前会再问你一次 ✓');
    });
})();
