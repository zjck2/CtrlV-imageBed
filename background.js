/*
    后台 service worker —— offscreen 文档的生命周期 + 任务路由。

    imgchr 免费账号没有 API key（实测领不到），跨站上传必须由一个真正的 imgchr 文档在同源
    环境里发请求。这里按需拉起一个隐藏的 offscreen 文档（内嵌不可见 imgchr iframe），任务
    完成且空闲一段时间后关掉。auth_token 和登录 cookie 全程留在 imgchr 的文档里，不跨出。

    刻意不做的事：抓 imgchr 首页、把一次性的 auth_token 抠出来跨站重放。那是 CSRF 防护，
    绕开它等于破解站方的安全控制，即使是给自己的账号传图也不行。
*/

'use strict';

var OFFSCREEN_URL = 'offscreen.html';
var JOB_TIMEOUT_MS = 120000;

// 自动更新（可选）：扩展是「加载已解压」装的，Chrome 不会自己重读文件夹。如果想在改完代码
// 后自动重载，把 UPDATE_URL 改成你磁盘上 manifest.json 的 file:// 地址（需要 chrome://extensions
// 里给本扩展开「允许访问文件网址」），版本比正在运行的新就整包重载。有任务在飞时不重载，避免
// 把上传掐死在半路。留空则不做任何检查。
var UPDATE_URL = '';
var UPDATE_PERIOD_MIN = 30;
var inFlight = 0;

function newerVersion(a, b) {
    var pa = String(a || '').split('.'), pb = String(b || '').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var x = parseInt(pa[i] || '0', 10) || 0, y = parseInt(pb[i] || '0', 10) || 0;
        if (x !== y) return x > y;
    }
    return false;
}

function checkForUpdate() {
    if (!UPDATE_URL) return;
    if (inFlight > 0) return;
    fetch(UPDATE_URL, { cache: 'no-store' }).then(function (r) { return r.text(); })
        .then(function (t) {
            var m = null;
            try { m = JSON.parse(t); } catch (e) { return; }
            if (m && m.version && newerVersion(m.version, chrome.runtime.getManifest().version)) {
                chrome.runtime.reload();
            }
        })
        .catch(function () { /* 没开文件访问权限或路径变了：静默跳过 */ });
}

function hasOffscreen() {
    if (chrome.runtime.getContexts) {
        return chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
            .then(function (ctxs) { return (ctxs || []).length > 0; });
    }
    // Chrome <116 没有 getContexts：靠 createDocument 报错判断。
    return chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : Promise.resolve(false);
}

function ensureOffscreen() {
    return hasOffscreen().then(function (yes) {
        if (yes) return;
        return chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: ['IFRAME_SCRIPTING'],
            justification: '在隐藏 iframe 中加载 imgchr.com 页面，由它自己发起同源上传/删除请求（该站点不提供免费账号 API）。'
        });
    }).catch(function (e) {
        // 竞态（文档刚好已被创建）不算失败。
        if (!/single offscreen document|already exists/i.test(String(e && e.message))) throw e;
    });
}

function closeOffscreen() {
    return hasOffscreen().then(function (yes) {
        if (!yes) return;
        return chrome.offscreen.closeDocument();
    }).catch(function () { /* already gone */ });
}

function runJob(job) {
    inFlight++;
    return ensureOffscreen().then(function () {
        var id = 'j' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        return new Promise(function (resolve) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                resolve({ ok: false, error: 'imgchr 后台通道超时（' + Math.round(JOB_TIMEOUT_MS / 1000) + ' 秒），请重试' });
            }, JOB_TIMEOUT_MS);
            try {
                chrome.runtime.sendMessage({ type: 'cvib-job', id: id, job: job }, function (resp) {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    var le = chrome.runtime.lastError;
                    if (le) resolve({ ok: false, error: '后台通道不可用：' + le.message });
                    else resolve(resp || { ok: false, error: 'imgchr 后台页面没有回应' });
                });
            } catch (e) {
                done = true;
                clearTimeout(timer);
                resolve({ ok: false, error: '扩展上下文已失效，请重载扩展或刷新页面：' + (e.message || e) });
            }
        });
    }).then(function (resp) {
        inFlight--;
        return resp;
    }, function (e) {
        inFlight--;
        throw e;
    });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    if (msg.type === 'cvib-upload' || msg.type === 'cvib-delete-due') {
        var job = msg.type === 'cvib-upload'
            ? { kind: 'upload', dataUrl: msg.dataUrl, name: msg.name, hours: msg.hours || 0 }
            : { kind: 'delete-due' };
        runJob(job).then(sendResponse);
        return true;   // 通道保持打开等异步应答
    }

    if (msg.type === 'cvib-offscreen-idle') {
        closeOffscreen();
        sendResponse({ ok: true });
        return false;
    }

    return false;
});

// 定时删除不依赖任何页面：到点由闹钟唤醒，若队列里真有到期项才拉起隐藏通道。
chrome.alarms.create('cvib-due', { delayInMinutes: 1, periodInMinutes: 5 });
chrome.alarms.create('cvib-update', { delayInMinutes: 2, periodInMinutes: UPDATE_PERIOD_MIN });

chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'cvib-update') { checkForUpdate(); return; }
    if (alarm.name !== 'cvib-due') return;
    chrome.storage.local.get(['deletes'], function (o) {
        var now = Date.now();
        var due = ((o && o.deletes) || []).filter(function (d) { return d.at <= now; });
        if (!due.length) return;
        runJob({ kind: 'delete-due' }).then(function () { /* 结果已由执行端写回存储 */ });
    });
});
