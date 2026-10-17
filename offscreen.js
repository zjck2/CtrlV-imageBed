/*
    offscreen 桥：一个不可见的 imgchr.com iframe + runtime 消息 ↔ postMessage 转发。

    为什么存在：imgchr 免费账号没有 API key，跨站上传必须由一个真正的 imgchr 文档来发
    同源请求。offscreen 文档让这个文档以隐藏 iframe 的形式活着——任务栏和标签栏都看不到，
    也不受前台标签页节流影响。token 和登录 cookie 全程留在 imgchr 的文档里。

    生命周期由 background.js 控制：空闲超时后它会请后台 closeDocument。
*/

'use strict';

// 用户可见文案走 _locales（浏览器语言 zh→中文，en→英文）。
var M = function (key, args) {
    try { return chrome.i18n.getMessage(key, args) || ''; } catch (e) { return ''; }
};

var FRAME_URL = 'https://imgchr.com/';
var FRAME_ORIGIN = 'https://imgchr.com';
var READY_TIMEOUT = 45000;
var IDLE_CLOSE_MS = 60000;

var frame = null;
var frameReady = false;
var readyWaiters = [];
var pending = new Map();   // id -> sendResponse
var queue = [];            // 到达时 iframe 还没就绪的任务
var idleTimer = null;

function createFrame() {
    frame = document.createElement('iframe');
    frame.src = FRAME_URL;
    frame.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:420px;height:420px;border:0;opacity:0;pointer-events:none';
    document.body.appendChild(frame);
}

createFrame();

window.addEventListener('message', function (e) {
    if (e.origin !== FRAME_ORIGIN || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || d.source !== 'cvib-frame-out') return;

    if (d.type === 'ready') {
        frameReady = true;
        clearTimeout(readyWaiters.t);
        var q = queue; queue = [];
        q.forEach(dispatch);
        return;
    }
    var entry = pending.get(d.id);
    if (entry) {
        pending.delete(d.id);
        armIdleTimer();
        // 必须包回 {ok, result} 信封再回给后台：执行端给的是裸结果，少了 ok 字段会被
        // 请求端当成失败（就是「上传成功却报上传失败」的根因）。
        if (d.ok) entry.sendResponse({ ok: true, result: d.result });
        else entry.sendResponse({ ok: false, error: d.error || M('errUploadFailed'), code: d.code || null });
    }
});

function dispatch(item) {
    if (!frameReady) {
        queue.push(item);
        if (queue.length === 1) {
            clearTimeout(readyWaiters.t);
            readyWaiters.t = setTimeout(function () {
                var stale = queue; queue = [];
                pending.clear();
                frameReady = false;
                // iframe 45 秒还没就绪：多半是站点改版或网络问题，重装一个再试由后台决定。
                stale.forEach(function (it) { it.sendResponse({ ok: false, error: M('errFrameTimeout') }); });
            }, READY_TIMEOUT);
        }
        return;
    }
    clearTimeout(readyWaiters.t);
    pending.set(item.id, item);
    armIdleTimer();
    try {
        frame.contentWindow.postMessage(
            { source: 'cvib-frame-in', id: item.id, job: item.job }, FRAME_ORIGIN);
    } catch (e) {
        pending.delete(item.id);
        item.sendResponse({ ok: false, error: M('errFrameUnavailable', [e.message || e]) });
    }
}

function armIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
        if (pending.size || queue.length) return;   // 有活干就不关
        try { chrome.runtime.sendMessage({ type: 'cvib-offscreen-idle' }, function () { void chrome.runtime.lastError; }); }
        catch (e) { /* context gone */ }
    }, IDLE_CLOSE_MS);
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'cvib-job' || !msg.id) return false;
    dispatch({ id: msg.id, job: msg.job, sendResponse: sendResponse });
    return true;   // 异步应答，通道保持打开
});
