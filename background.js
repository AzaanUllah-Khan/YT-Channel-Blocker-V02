// YT Guardian — background.js
'use strict';

function todayStr() { return new Date().toDateString(); }
function isNuclearActive(data) {
  return !!(data.nuclearMode && data.nuclearUntil && Date.now() < data.nuclearUntil);
}

async function updateStreak() {
  var data   = await chrome.storage.local.get('focusStreak');
  var streak = data.focusStreak || { currentStreak:0, longestStreak:0, lastFocusDay:null, history:[] };
  var t      = todayStr();
  if (streak.lastFocusDay === t) return streak;
  var yesterday = new Date(Date.now()-86400000).toDateString();
  streak.currentStreak = (streak.lastFocusDay===yesterday) ? streak.currentStreak+1 : 1;
  if (streak.currentStreak > streak.longestStreak) streak.longestStreak = streak.currentStreak;
  streak.lastFocusDay = t;
  streak.history = streak.history || [];
  streak.history.push({ date:t, streak:streak.currentStreak });
  if (streak.history.length > 180) streak.history.splice(0, streak.history.length-180);
  await chrome.storage.local.set({ focusStreak: streak });
  return streak;
}

async function redirectToHome(tabId) {
  try { await chrome.tabs.update(tabId, { url:'https://www.youtube.com/' }); } catch(_){}
}

function logAttempt(channelId, channelName) {
  chrome.storage.local.get('addictionLog').then(function(data) {
    var log = data.addictionLog || [];
    log.push({ channelId:channelId, channelName:channelName, at:Date.now() });
    if (log.length > 500) log.splice(0, log.length-500);
    chrome.storage.local.set({ addictionLog: log });
  });
}

async function checkAndRedirect(tabId, url) {
  if (!url || !url.includes('youtube.com')) return;
  var data    = await chrome.storage.local.get(['blockedChannels','nuclearMode','nuclearUntil']);
  var blocked = data.blockedChannels || {};
  if (Object.keys(blocked).length === 0) return;
  if (data.nuclearMode && data.nuclearUntil && Date.now() >= data.nuclearUntil)
    await chrome.storage.local.set({ nuclearMode:false, nuclearUntil:null });
  var m = url.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  if (m && blocked[m[1]]) {
    logAttempt(m[1], blocked[m[1]].name);
    await redirectToHome(tabId);
  }
}

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (changeInfo.status==='loading' || changeInfo.url) {
    var url = changeInfo.url || tab.url || '';
    if (url.includes('youtube.com')) checkAndRedirect(tabId, url);
  }
});

chrome.tabs.onActivated.addListener(function(activeInfo) {
  chrome.tabs.get(activeInfo.tabId, function(tab) {
    if (tab && tab.url && tab.url.includes('youtube.com'))
      checkAndRedirect(activeInfo.tabId, tab.url);
  });
});

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {

  if (msg.type === 'CHECK_CHANNEL') {
    chrome.storage.local.get(['blockedChannels','nuclearMode','nuclearUntil']).then(function(data) {
      var blocked = data.blockedChannels || {};
      var info    = blocked[msg.channelId] || null;
      sendResponse({ isBlocked:!!info, nuclearActive:isNuclearActive(data), channelInfo:info });
    });
    return true;
  }

  // ── Fetch channel info by raw ID (preview step, no storage write) ──
  // Validates format, then resolves the real name and @handle using two
  // strategies: (1) lightweight oEmbed endpoint via a representative video
  // is not viable without a video id, so we fetch the channel page directly,
  // with detailed error info returned so failures are diagnosable.
  if (msg.type === 'FETCH_CHANNEL_INFO') {
    (async function () {
      var cid = (msg.channelId || '').trim();

      // Strict format check: UC + 22 chars = 24 total, alphanumeric/-/_
      if (!/^UC[\w-]{22}$/.test(cid)) {
        sendResponse({ success:false, reason:'invalid_format' });
        return;
      }

      var data    = await chrome.storage.local.get('blockedChannels');
      var blocked = data.blockedChannels || {};

      if (blocked[cid]) {
        sendResponse({ success:false, reason:'already_blocked', name: blocked[cid].name });
        return;
      }

      var name   = null;
      var handle = null;
      var errDetail = null;

      try {
        var resp = await fetch('https://www.youtube.com/channel/' + cid + '?hl=en', {
          credentials: 'omit',
          headers: { 'Accept-Language': 'en-US,en;q=0.9' }
        });

        if (!resp.ok) {
          sendResponse({ success:false, reason:'fetch_failed', detail: 'HTTP ' + resp.status });
          return;
        }

        var text = await resp.text();

        // externalId confirms the ID is real and the page is a channel page
        var hasExternal = new RegExp('"externalId"\\s*:\\s*"' + cid + '"').test(text);

        // Channel title — try several patterns, ytInitialData first
        var titleMatch =
          text.match(/"channelMetadataRenderer"\s*:\s*\{\s*"title"\s*:\s*"([^"]+)"/) ||
          text.match(/"title"\s*:\s*"([^"]+)"\s*,\s*"description"/) ||
          text.match(/<meta\s+property="og:title"\s+content="([^"]*)"/) ||
          text.match(/<meta\s+name="title"\s+content="([^"]*)"/) ||
          text.match(/<title>([^<]+)<\/title>/);

        if (titleMatch && titleMatch[1]) {
          name = titleMatch[1]
            .replace(/ - YouTube\s*$/, '')
            .replace(/\\u0026/g, '&')
            .replace(/&amp;/g, '&')
            .trim();
        }

        // Handle (vanity URL)
        var vanityMatch = text.match(/"vanityChannelUrl"\s*:\s*"https?:\/\/(?:www\.)?youtube\.com\/(@[\w.-]+)"/);
        if (vanityMatch && vanityMatch[1]) {
          handle = vanityMatch[1].toLowerCase();
        }

        if (!name && !hasExternal) {
          sendResponse({ success:false, reason:'fetch_failed', detail: 'channel_not_found' });
          return;
        }

        if (!name) name = cid; // externalId confirmed but title not parsed — still allow

      } catch (e) {
        sendResponse({ success:false, reason:'fetch_error', detail: (e && e.message) || String(e) });
        return;
      }

      sendResponse({ success:true, channelId: cid, name:name, handle:handle });
    })();
    return true;
  }

  if (msg.type === 'BLOCK_CHANNEL') {
    chrome.storage.local.get('blockedChannels').then(function(data) {
      var blocked = data.blockedChannels || {};
      blocked[msg.channelId] = {
        name:msg.channelName,
        handle: msg.channelHandle || null,
        blockedAt:Date.now()
      };
      chrome.storage.local.set({ blockedChannels:blocked }).then(function() {
        sendResponse({ success:true });
      });
    });
    return true;
  }

  if (msg.type === 'UNBLOCK_CHANNEL') {
    chrome.storage.local.get(['blockedChannels','nuclearMode','nuclearUntil']).then(function(data) {
      if (isNuclearActive(data)) { sendResponse({ success:false, reason:'nuclear' }); return; }
      var blocked = data.blockedChannels || {};
      delete blocked[msg.channelId];
      chrome.storage.local.set({ blockedChannels:blocked }).then(function() {
        sendResponse({ success:true });
      });
    });
    return true;
  }

  if (msg.type === 'REDIRECT_BLOCKED') {
    logAttempt(msg.channelId, msg.channelName);
    if (sender.tab && sender.tab.id) redirectToHome(sender.tab.id);
    sendResponse({ ok:true });
    return true;
  }

  if (msg.type === 'GET_STREAK') {
    chrome.storage.local.get('focusStreak').then(function(data) {
      sendResponse({ streak: data.focusStreak || { currentStreak:0, longestStreak:0, lastFocusDay:null, history:[] } });
    });
    return true;
  }

  if (msg.type === 'MARK_FOCUS_DAY') {
    updateStreak().then(function(streak) { sendResponse({ streak:streak }); });
    return true;
  }
});

function init() {
  chrome.storage.local.get('blockedChannels').then(function(data) {
    if (data.blockedChannels === undefined)
      chrome.storage.local.set({ blockedChannels:{} });
  });
}

chrome.runtime.onInstalled.addListener(function() {
  init();
  chrome.alarms.create('daily-streak-check', { periodInMinutes:60 });
});
init();

chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name !== 'daily-streak-check') return;
  chrome.storage.local.get(['addictionLog','focusStreak']).then(function(data) {
    var t   = todayStr();
    var str = data.focusStreak || {};
    if (str.lastFocusDay === t) return;
    var v = (data.addictionLog||[]).filter(function(e){ return new Date(e.at).toDateString()===t; });
    if (v.length === 0) updateStreak();
  });
});
