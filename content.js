// YT Guardian — content.js
// Blocks blocked channels on EVERY YouTube surface.
'use strict';

(function () {

  // ─── State ───────────────────────────────────────────────────────────────
  var lastKey     = null;
  var redirecting = false;
  var checkTimer  = null;
  var filterTimer = null;
  var styleInjected = false;

  // ─── Channel ID extraction ────────────────────────────────────────────────

  function fromUrl() {
    var m = location.pathname.match(/\/channel\/(UC[\w-]{22})/);
    return m ? m[1] : null;
  }

  function fromYtInitialData() {
    try {
      var d = window.ytInitialData;
      if (!d) return null;
      // Watch page: secondary info owner
      var two = d.contents && d.contents.twoColumnWatchNextResults;
      if (two) {
        var rr = two.results && two.results.results && two.results.results.contents;
        if (rr) {
          for (var i = 0; i < rr.length; i++) {
            var sec = rr[i] && rr[i].videoSecondaryInfoRenderer;
            if (sec && sec.owner && sec.owner.videoOwnerRenderer) {
              var ep = sec.owner.videoOwnerRenderer.navigationEndpoint;
              if (ep && ep.browseEndpoint && ep.browseEndpoint.browseId) {
                var bid = ep.browseEndpoint.browseId;
                if (bid && bid.length > 20) return bid;
              }
            }
          }
        }
      }
      // Channel page header (classic)
      if (d.header && d.header.c4TabbedHeaderRenderer) {
        var cid = d.header.c4TabbedHeaderRenderer.channelId;
        if (cid && cid.length > 20) return cid;
      }
      // metadata.channelMetadataRenderer — most reliable for @handle pages
      if (d.metadata && d.metadata.channelMetadataRenderer) {
        var eid = d.metadata.channelMetadataRenderer.externalId;
        if (eid && eid.length > 20) return eid;
      }
      // New pageHeaderRenderer layout (2024+) — channelId inside content actions
      if (d.header && d.header.pageHeaderRenderer) {
        try {
          var phrStr = JSON.stringify(d.header.pageHeaderRenderer);
          var phrM = phrStr.match(/"(UC[\w-]{22})"/);
          if (phrM) return phrM[1];
        } catch (_) {}
      }
      // Playlist page — get owner channel id
      var ph = d.header && d.header.playlistHeaderRenderer;
      if (ph && ph.ownerEndpoint && ph.ownerEndpoint.browseEndpoint) {
        var pid = ph.ownerEndpoint.browseEndpoint.browseId;
        if (pid && pid.length > 20) return pid;
      }
    } catch (e) {}
    return null;
  }

  function fromPlayerResponse() {
    try {
      var pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails && pr.videoDetails.channelId)
        return pr.videoDetails.channelId;
    } catch (e) {}
    return null;
  }

  function fromDOM() {
    var sels = [
      'ytd-video-owner-renderer a[href]',
      '#upload-info ytd-channel-name a[href]',
      '#owner ytd-channel-name a[href]',
      'ytd-shorts ytd-reel-player-header-renderer a[href]',
      'ytd-playlist-header-renderer a[href*="/channel/"]',
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && el.href) {
        var m = el.href.match(/\/channel\/(UC[\w-]{22})/);
        if (m) return m[1];
      }
    }
    var meta = document.querySelector('meta[itemprop="channelId"]');
    if (meta) return meta.getAttribute('content') || null;
    var canon = document.querySelector('link[rel="canonical"]');
    if (canon) {
      var m2 = canon.href.match(/\/channel\/(UC[\w-]{22})/);
      if (m2) return m2[1];
    }
    return null;
  }

  function getChannelId() {
    // On watch/shorts pages, ytInitialPlayerResponse is keyed to the CURRENT
    // video (videoDetails.videoId), making it the most trustworthy source —
    // especially for Radio/Mix playlists (&list=RD...) where ytInitialData's
    // secondary-info owner can lag behind and point to a previous video's channel.
    if (isWatch() || isShorts()) {
      var fromPR = fromPlayerResponse();
      if (fromPR) return fromPR;
    }
    return fromUrl() || fromYtInitialData() || fromPlayerResponse() || fromDOM() || null;
  }

  function getVideoId() {
    // /watch?v=  or  /shorts/VIDEO_ID
    var m = location.search.match(/[?&]v=([\w-]{11})/);
    if (m) return m[1];
    var m2 = location.pathname.match(/\/shorts\/([\w-]{11})/);
    if (m2) return m2[1];
    return null;
  }

  function getName() {
    // 1. Player response (video pages)
    try {
      var pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails && pr.videoDetails.author) return pr.videoDetails.author;
    } catch (_) {}

    // 2. ytInitialData — try every known header/metadata shape
    try {
      var yd = window.ytInitialData;
      if (yd) {
        // Classic channel header
        if (yd.header && yd.header.c4TabbedHeaderRenderer && yd.header.c4TabbedHeaderRenderer.title)
          return yd.header.c4TabbedHeaderRenderer.title;

        // New pageHeaderRenderer (2024+ channel layout)
        if (yd.header && yd.header.pageHeaderRenderer) {
          var phr = yd.header.pageHeaderRenderer;
          var pt = phr.pageTitle ||
                   (phr.content && phr.content.pageHeaderViewModel &&
                    phr.content.pageHeaderViewModel.title &&
                    phr.content.pageHeaderViewModel.title.dynamicTextViewModel &&
                    phr.content.pageHeaderViewModel.title.dynamicTextViewModel.text &&
                    phr.content.pageHeaderViewModel.title.dynamicTextViewModel.text.content);
          if (pt) return pt;
        }

        // Channel metadata renderer
        if (yd.metadata && yd.metadata.channelMetadataRenderer && yd.metadata.channelMetadataRenderer.title)
          return yd.metadata.channelMetadataRenderer.title;

        // Watch page secondary info owner title
        var rr = yd.contents && yd.contents.twoColumnWatchNextResults &&
          yd.contents.twoColumnWatchNextResults.results &&
          yd.contents.twoColumnWatchNextResults.results.results &&
          yd.contents.twoColumnWatchNextResults.results.results.contents;
        if (rr) {
          for (var i = 0; i < rr.length; i++) {
            var sec = rr[i] && rr[i].videoSecondaryInfoRenderer;
            if (sec && sec.owner && sec.owner.videoOwnerRenderer && sec.owner.videoOwnerRenderer.title) {
              var t = sec.owner.videoOwnerRenderer.title;
              var txt = t.simpleText || (t.runs && t.runs[0] && t.runs[0].text);
              if (txt) return txt;
            }
          }
        }
      }
    } catch (_) {}

    // 3. DOM selectors — covers @handle channel pages and watch pages
    var sels = [
      'ytd-video-owner-renderer #channel-name yt-formatted-string',
      '#owner-name a',
      'ytd-channel-name yt-formatted-string#text',
      'ytd-channel-name #text',
      'yt-dynamic-text-view-model h1 span',
      '#channel-header-container ytd-channel-name yt-formatted-string',
      '#inner-header-container ytd-channel-name',
      'ytd-channel-name yt-formatted-string',
      '#text.ytd-channel-name',
    ];
    for (var s = 0; s < sels.length; s++) {
      var el = document.querySelector(sels[s]);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }

    // 4. document.title — strip trailing " - YouTube" and leading video title if present
    var t2 = document.title.replace(/ - YouTube$/, '').trim();
    return t2 || 'Unknown Channel';
  }

  // ─── Get the @handle of the current channel page (if any) ────────────────
  function getHandle() {
    // From URL directly
    var m = location.pathname.match(/^\/@([\w.-]+)/);
    if (m) return '@' + m[1].toLowerCase();
    // From ytInitialData
    try {
      var yd = window.ytInitialData;
      if (yd && yd.metadata && yd.metadata.channelMetadataRenderer) {
        var v = yd.metadata.channelMetadataRenderer.vanityChannelUrl;
        if (v) {
          var vm = v.match(/\/@([\w.-]+)/);
          if (vm) return '@' + vm[1].toLowerCase();
        }
      }
      if (yd && yd.header && yd.header.c4TabbedHeaderRenderer) {
        var h = yd.header.c4TabbedHeaderRenderer.channelHandleText;
        var txt = h && (h.simpleText || (h.runs && h.runs[0] && h.runs[0].text));
        if (txt) return txt.toLowerCase().trim();
      }
    } catch (_) {}
    return null;
  }

  function getTitle() {
    try { var pr = window.ytInitialPlayerResponse; if (pr && pr.videoDetails && pr.videoDetails.title) return pr.videoDetails.title; } catch (_) {}
    var el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, #title h1');
    return el ? el.textContent.trim() : document.title.replace(' - YouTube', '').trim();
  }

  // ─── Page type detection ──────────────────────────────────────────────────

  function path() { return location.pathname; }

  function isWatch()    { return path() === '/watch'; }
  function isShorts()   { return path().startsWith('/shorts/'); }
  function isChan()     { return path().startsWith('/channel/') || path().startsWith('/@') || path().startsWith('/user/') || path().startsWith('/c/'); }
  function isPlaylist() { return path() === '/playlist'; }
  function isSearch()   { return path() === '/results'; }
  function isFeed()     { return path() === '/' || path().startsWith('/feed'); }

  // Pages where we redirect the whole page if channel is blocked
  function isRedirectPage() { return isWatch() || isShorts() || isChan() || isPlaylist(); }

  // Pages where we do DOM card filtering only
  function isFilterPage() { return isFeed() || isSearch(); }

  // ─── Redirect ─────────────────────────────────────────────────────────────

  function redirectHome(channelId, channelName) {
    if (redirecting) return;
    redirecting = true;
    clearTimeout(checkTimer);
    try { chrome.runtime.sendMessage({ type: 'REDIRECT_BLOCKED', channelId: channelId, channelName: channelName || '' }); } catch (_) {}
    location.replace('https://www.youtube.com/');
  }

  // ─── CSS injection for card hiding ───────────────────────────────────────

  function injectStyle() {
    if (styleInjected || document.getElementById('ytg-style')) return;
    styleInjected = true;
    var s = document.createElement('style');
    s.id = 'ytg-style';
    s.textContent = '.ytg-hidden { display: none !important; }';
    (document.head || document.documentElement).appendChild(s);
  }

  // Normalize a channel name for fuzzy comparison:
  // lowercase, strip whitespace/punctuation/emoji-ish symbols
  function normName(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[\s\u200b\u200c\u200d\uFEFF]/g, '')   // whitespace + zero-width chars
      .replace(/[^\w]/g, '');                              // strip punctuation/symbols
  }

  // ─── DOM card filtering ───────────────────────────────────────────────────
  // Runs on: home, feed, search results, and ALSO the sidebar/playlist panel
  // on watch pages, and related videos everywhere.

  var CARD_SELECTORS = [
    // Home / feed grid
    'ytd-rich-item-renderer',
    // Sidebar / related
    'ytd-compact-video-renderer',
    'ytd-compact-playlist-renderer',
    // Search results
    'ytd-video-renderer',
    'ytd-channel-renderer',
    'ytd-playlist-renderer',
    // Grid views
    'ytd-grid-video-renderer',
    'ytd-grid-channel-renderer',
    // Shorts shelf
    'ytd-reel-item-renderer',
    'ytd-shorts',
    // Playlist items
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    // Mixes / radio
    'ytd-radio-renderer',
    // Shelf videos
    'ytd-shelf-renderer',
    // Horizontal card list items
    'ytd-horizontal-card-list-renderer',
  ];

  function filterCards() {
    chrome.storage.local.get('blockedChannels', function (data) {
      var blocked = data.blockedChannels || {};
      var ids     = Object.keys(blocked);
      if (!ids.length) return;

      injectStyle();

      var names    = ids.map(function (id) { return (blocked[id].name || '').toLowerCase().trim(); });
      var normSet  = {}; ids.forEach(function (id) { var n = normName(blocked[id].name); if (n) normSet[n] = true; });
      var handles  = {}; // handle -> true, for fast lookup
      ids.forEach(function (id) {
        var h = blocked[id].handle;
        if (h) handles[h.toLowerCase().trim()] = true;
      });

      CARD_SELECTORS.forEach(function (sel) {
        document.querySelectorAll(sel + ':not(.ytg-ok)').forEach(function (card) {
          card.classList.add('ytg-ok');

          // 1. Channel ID via /channel/UCxxx link inside the card
          var links = card.querySelectorAll('a[href*="/channel/UC"]');
          for (var i = 0; i < links.length; i++) {
            var m = links[i].href.match(/\/channel\/(UC[\w-]{22})/);
            if (m && blocked[m[1]]) { card.classList.add('ytg-hidden'); return; }
          }

          // 2. Channel via /@handle link — match against stored handle (ID-based, reliable)
          var handleLinks = card.querySelectorAll('a[href^="/@"], a[href*="youtube.com/@"]');
          for (var j = 0; j < handleLinks.length; j++) {
            var hm = handleLinks[j].getAttribute('href').match(/\/@([\w.-]+)/);
            if (hm) {
              var slug = '@' + hm[1].toLowerCase();
              if (handles[slug]) { card.classList.add('ytg-hidden'); return; }
              // Fallback: match link text against stored names
              var hname = (handleLinks[j].textContent || '').toLowerCase().trim();
              if (hname && names.indexOf(hname) !== -1) { card.classList.add('ytg-hidden'); return; }
            }
          }

          // 3. Channel name text match (ytd-channel-name, #channel-name, byline)
          var nameEls = card.querySelectorAll([
            '#channel-name',
            'ytd-channel-name',
            '#byline-container',
            '.ytd-channel-name',
            'yt-formatted-string.ytd-channel-name',
            '#owner-name',
            '.channel-name',
            'ytd-video-meta-block #channel-name',
            'ytd-reel-player-header-renderer #channel-name',
          ].join(','));

          for (var k = 0; k < nameEls.length; k++) {
            var rawN = nameEls[k].textContent.trim();
            var n    = rawN.toLowerCase();
            if (n && names.indexOf(n) !== -1) { card.classList.add('ytg-hidden'); return; }
            // Fuzzy fallback: normalized comparison (handles whitespace/emoji/punctuation diffs)
            var norm = normName(rawN);
            if (norm && normSet[norm]) { card.classList.add('ytg-hidden'); return; }
          }

          // 4. Fuzzy match @handle link text too (covers truncated/styled handle text)
          for (var hl = 0; hl < handleLinks.length; hl++) {
            var hlNorm = normName(handleLinks[hl].textContent);
            if (hlNorm && normSet[hlNorm]) { card.classList.add('ytg-hidden'); return; }
          }
        });
      });
    });
  }

  // Also filter the playlist panel sidebar on watch pages
  function filterPlaylistPanel() {
    chrome.storage.local.get('blockedChannels', function (data) {
      var blocked = data.blockedChannels || {};
      var ids     = Object.keys(blocked);
      if (!ids.length) return;
      injectStyle();
      var names   = ids.map(function (id) { return (blocked[id].name || '').toLowerCase().trim(); });
      var normSet = {}; ids.forEach(function (id) { var n = normName(blocked[id].name); if (n) normSet[n] = true; });
      var handles = {};
      ids.forEach(function (id) {
        var h = blocked[id].handle;
        if (h) handles[h.toLowerCase().trim()] = true;
      });

      document.querySelectorAll('ytd-playlist-panel-video-renderer:not(.ytg-ok)').forEach(function (card) {
        card.classList.add('ytg-ok');

        // Channel ID link
        var links = card.querySelectorAll('a[href*="/channel/UC"]');
        for (var i = 0; i < links.length; i++) {
          var m = links[i].href.match(/\/channel\/(UC[\w-]{22})/);
          if (m && blocked[m[1]]) { card.classList.add('ytg-hidden'); return; }
        }

        // @handle link
        var hLinks = card.querySelectorAll('a[href^="/@"], a[href*="youtube.com/@"]');
        for (var j = 0; j < hLinks.length; j++) {
          var hm = hLinks[j].getAttribute('href').match(/\/@([\w.-]+)/);
          if (hm) {
            var slug = '@' + hm[1].toLowerCase();
            if (handles[slug]) { card.classList.add('ytg-hidden'); return; }
          }
        }

        // Byline text fallback (exact + fuzzy)
        var byline = card.querySelector('#byline, .byline-item, #channel-name');
        if (byline) {
          var rawN = byline.textContent.trim();
          var n    = rawN.toLowerCase();
          if (n && names.indexOf(n) !== -1) { card.classList.add('ytg-hidden'); return; }
          var norm = normName(rawN);
          if (norm && normSet[norm]) { card.classList.add('ytg-hidden'); return; }
        }
      });
    });
  }

  // ── Hide playlist/mix cards if ANY video inside belongs to a blocked channel ──
  // Reads ytInitialData for the home feed / search results, which embeds
  // per-video owner info for playlistRenderer / radioRenderer items.
  function filterPlaylistCards() {
    chrome.storage.local.get('blockedChannels', function (data) {
      var blocked = data.blockedChannels || {};
      var ids     = Object.keys(blocked);
      if (!ids.length) return;
      injectStyle();

      var names   = ids.map(function (id) { return (blocked[id].name || '').toLowerCase().trim(); });
      var normSet = {}; ids.forEach(function (id) { var n = normName(blocked[id].name); if (n) normSet[n] = true; });

      // Selectors for playlist/mix cards that may contain multiple videos
      var sels = ['ytd-radio-renderer', 'ytd-playlist-renderer', 'ytd-compact-playlist-renderer', 'ytd-rich-item-renderer'];

      sels.forEach(function (sel) {
        document.querySelectorAll(sel + ':not(.ytg-pl-checked)').forEach(function (card) {
          card.classList.add('ytg-pl-checked');

          // Only proceed if this card actually represents a playlist/mix
          // (ytd-rich-item-renderer can also wrap single videos — skip those,
          // filterCards already handles single videos)
          var isPlaylistCard = card.tagName.toLowerCase() !== 'ytd-rich-item-renderer'
            || card.querySelector('ytd-playlist-renderer, ytd-radio-renderer, [overlay-style="MIX"]');
          if (!isPlaylistCard) return;

          // Collect all visible "channel name" hints inside the card —
          // playlist thumbnails sometimes show a stack of mini video previews
          // each with their own channel byline in tooltip/aria text.
          var textNodes = card.querySelectorAll(
            '#channel-name, ytd-channel-name, #byline-container, .ytd-channel-name, #owner-text, [aria-label]'
          );
          for (var i = 0; i < textNodes.length; i++) {
            var raw = (textNodes[i].textContent || textNodes[i].getAttribute('aria-label') || '').trim();
            if (!raw) continue;
            var low = raw.toLowerCase();
            if (names.indexOf(low) !== -1) { card.classList.add('ytg-hidden'); return; }
            var norm = normName(raw);
            if (normSet[norm]) { card.classList.add('ytg-hidden'); return; }
          }

          // Check /channel/UC and /@handle links anywhere in the card
          var links = card.querySelectorAll('a[href*="/channel/UC"], a[href^="/@"], a[href*="youtube.com/@"]');
          for (var j = 0; j < links.length; j++) {
            var href = links[j].getAttribute('href') || '';
            var cm = href.match(/\/channel\/(UC[\w-]{22})/);
            if (cm && blocked[cm[1]]) { card.classList.add('ytg-hidden'); return; }
          }
        });
      });
    });
  }

  // ─── Core redirect check ──────────────────────────────────────────────────

  function doCheck() {
    if (!isRedirectPage() || redirecting) return;

    var vid = getVideoId();
    var cid = getChannelId();

    if (!cid) {
      checkTimer = setTimeout(doCheck, 250);
      return;
    }

    // Freshness check on watch/shorts pages
    if ((isWatch() || isShorts()) && vid) {
      try {
        var pr = window.ytInitialPlayerResponse;
        if (pr && pr.videoDetails && pr.videoDetails.videoId !== vid) {
          checkTimer = setTimeout(doCheck, 250);
          return;
        }
      } catch (_) {}
    }

    var key = cid + '|' + (vid || path());
    if (key === lastKey) return;

    chrome.storage.local.get('blockedChannels', function (data) {
      if (redirecting) return;
      var blocked = data.blockedChannels || {};
      if (!blocked[cid]) return;
      lastKey = key;
      redirectHome(cid, blocked[cid].name || cid);
    });
  }

  // ─── Full page run ────────────────────────────────────────────────────────

  function runPage() {
    if (isRedirectPage()) {
      doCheck();
    }
    // Always filter cards — they appear on all page types including watch sidebar
    scheduleFilter();
  }

  function scheduleFilter() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(function () {
      filterCards();
      filterPlaylistCards();
      if (isWatch()) filterPlaylistPanel();
    }, 200);
  }

  // ─── Navigation handling ──────────────────────────────────────────────────

  var curUrl = location.href;

  function onNav() {
    if (location.href === curUrl) return;
    curUrl      = location.href;
    lastKey     = null;
    redirecting = false;
    clearTimeout(checkTimer);
    // Reset card-check flags so new cards are re-evaluated
    document.querySelectorAll('.ytg-ok').forEach(function (el) { el.classList.remove('ytg-ok'); });
    document.querySelectorAll('.ytg-pl-checked').forEach(function (el) { el.classList.remove('ytg-pl-checked'); });
    runPage();
  }

  document.addEventListener('yt-navigate-start', function () {
    clearTimeout(checkTimer);
    redirecting = false;
    lastKey     = null;
  });

  document.addEventListener('yt-page-data-updated', function () {
    curUrl = location.href;
    document.querySelectorAll('.ytg-ok').forEach(function (el) { el.classList.remove('ytg-ok'); });
    document.querySelectorAll('.ytg-pl-checked').forEach(function (el) { el.classList.remove('ytg-pl-checked'); });
    runPage();
  });

  document.addEventListener('yt-navigate-finish', function () { onNav(); });

  window.addEventListener('popstate', function () {
    lastKey = null; redirecting = false;
    setTimeout(onNav, 100);
  });

  var mutT = null;
  new MutationObserver(function () {
    if (location.href !== curUrl) {
      clearTimeout(mutT);
      mutT = setTimeout(onNav, 150);
    } else {
      // Same page — new cards may have loaded (infinite scroll, etc.)
      scheduleFilter();
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  // ─── Initial load ─────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runPage);
  } else {
    runPage();
  }

  // ─── Popup bridge ─────────────────────────────────────────────────────────

  window.__ytgCurrentPage = function () {
    return {
      channelId:   getChannelId(),
      channelName: getName(),
      videoId:     getVideoId(),
      videoTitle:  getTitle()
    };
  };

})();
