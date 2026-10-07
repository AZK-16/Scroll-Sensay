const SCROLL_DEBOUNCE = 3000;

let enabled = false;
let lastViewportText = '';
let lastResult = { label: null, explanation: [] };
let panelOpen = false;

// --- Indicator dot ---

const indicator = document.createElement('div');
indicator.id = 'hh-indicator';
indicator.textContent = '😊';
document.body.appendChild(indicator);

function setIndicator(label) {
  indicator.classList.remove('hh-green', 'hh-amber', 'hh-red');
  if (label === 'green')      { indicator.classList.add('hh-green'); indicator.textContent = '😊'; }
  else if (label === 'amber') { indicator.classList.add('hh-amber'); indicator.textContent = '🤔'; }
  else if (label === 'red')   { indicator.classList.add('hh-red');   indicator.textContent = '😧'; }
  else                        {                                       indicator.textContent = '😊'; }
}

// --- Reasons panel ---

const panel = document.createElement('div');
panel.id = 'hh-panel';
document.body.appendChild(panel);

function buildPanel() {
  panel.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'hh-panel-header';

  const titleWrap = document.createElement('div');

  const title = document.createElement('div');
  title.className = 'hh-panel-title';
  title.textContent = lastResult.label === null ? "Sensay's Advice:\nStill scanning…"
    : lastResult.label === 'green' ? "Sensay's Advice:\nNo concerns found"
    : "Sensay's Advice:\nWorth a closer look";
  title.style.whiteSpace = 'pre-line';
  titleWrap.appendChild(title);
  header.appendChild(titleWrap);

  const audio = document.createElement('button');
  audio.className = 'hh-panel-audio';
  audio.innerHTML = '<img src="' + chrome.runtime.getURL('icons/audio-icon.svg') + '" width="18" height="18" alt="Read aloud" />';
  audio.setAttribute('aria-label', 'Read aloud');
  audio.addEventListener('click', (e) => {
    e.stopPropagation();
    speakResult();
  });
  header.appendChild(audio);

  panel.appendChild(header);

  if (lastResult.label !== null) {
    const divider = document.createElement('div');
    divider.className = 'hh-panel-divider';
    panel.appendChild(divider);

    if (lastResult.explanation && lastResult.explanation.length > 0) {
      lastResult.explanation.forEach(point => {
        const pointEl = document.createElement('div');
        pointEl.className = `hh-panel-point hh-${lastResult.label}`;
        pointEl.textContent = typeof point === 'object' ? (point.body || '') : String(point);
        panel.appendChild(pointEl);
      });
    }
  }
}

function speakResult() {
  if (!window.speechSynthesis) return;
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    return;
  }
  const parts = (lastResult.explanation || []).map(p =>
    typeof p === 'object' ? (p.body || '') : String(p)
  );
  const u = new SpeechSynthesisUtterance(parts.join('. '));
  speechSynthesis.speak(u);
}

function showPanel() {
  buildPanel();
  panel.classList.add('hh-open');
  panelOpen = true;
}

function hidePanel() {
  panel.classList.remove('hh-open');
  panelOpen = false;
}

indicator.addEventListener('click', (e) => {
  e.stopPropagation();
  panelOpen ? hidePanel() : showPanel();
});

document.addEventListener('click', (e) => {
  if (panelOpen && !panel.contains(e.target)) hidePanel();
});

// --- Enabled state (storage-driven, live-updating, opt-in by default) ---

function applyEnabledState() {
  if (!enabled) {
    hidePanel();
    indicator.style.display = 'none';
  } else {
    indicator.style.display = '';
  }
}

const SCAN_READY_RETRY_DELAY = 500;
const SCAN_READY_MAX_RETRIES = 6; // ~3 seconds total before giving up quietly

function attemptScanUntilReady(retriesLeft = SCAN_READY_MAX_RETRIES) {
  if (!enabled) return; // re-checked on every retry, not just the first attempt
  const text = getViewportText();
  if (text && text.length >= 200) {
    updateIndicator(); // real content found — run the actual scan now
    return;
  }
  if (retriesLeft <= 0) return; // give up quietly; a scroll will trigger it naturally later
  setTimeout(() => attemptScanUntilReady(retriesLeft - 1), SCAN_READY_RETRY_DELAY);
}

chrome.storage.local.get(['enabled'], (r) => {
  enabled = r.enabled === true; // opt-in: only ON if explicitly set to true
  applyEnabledState();
  attemptScanUntilReady(); // retry a few times in case page content hasn't rendered in yet
});

chrome.storage.onChanged.addListener((c) => {
  if (c.enabled) {
    enabled = c.enabled.newValue === true;
    applyEnabledState();
    if (enabled) attemptScanUntilReady(); // start scanning as soon as toggled on, not just on next scroll
  }
});

// --- Detect in-page (SPA-style) navigation ---
// Many news sites swap article content via JavaScript without a full page
// reload, so the content script never gets freshly re-injected. Without
// this, the extension can appear "stuck" on the previous article until a
// manual refresh. We watch for URL changes via pushState/replaceState
// (used by most client-side routers) and browser back/forward (popstate),
// reset per-page state, and re-run the same ready-check scan used on load.

// A "page" is the address without the #hash. Live blogs and long articles often change the
// #hash as you scroll to a post; that's the same page, so it must NOT reset state and rescan.
function pageKey() {
  return location.origin + location.pathname + location.search;
}

let lastKnownUrl = pageKey();

function handlePossibleNavigation() {
  const key = pageKey();
  if (key === lastKnownUrl) return;
  lastKnownUrl = key;

  // Reset state so the new page's content isn't compared against the
  // previous page's last-scanned text or shown result.
  lastViewportText = '';
  lastResult = { label: null, explanation: [] };
  setIndicator(null);
  if (panelOpen) buildPanel();

  attemptScanUntilReady();
}

const _pushState = history.pushState;
history.pushState = function (...args) {
  _pushState.apply(this, args);
  handlePossibleNavigation();
};

const _replaceState = history.replaceState;
history.replaceState = function (...args) {
  _replaceState.apply(this, args);
  handlePossibleNavigation();
};

window.addEventListener('popstate', handlePossibleNavigation);

// --- API ---

const TEXT_CACHE_MAX = 50;
const SESSION_CACHE_KEY = 'hh_text_cache';

function loadCacheFromSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return new Map();
    return new Map(JSON.parse(raw));
  } catch (err) {
    return new Map(); // unavailable or corrupted — start fresh, extension still works normally
  }
}

function saveCacheToSession() {
  try {
    sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify([...textCache.entries()]));
  } catch (err) {
    // sessionStorage unavailable/full — fail silently, cache just won't persist this time
  }
}

const textCache = loadCacheFromSession();

// Requests currently in flight, keyed by the exact text being checked. The cache above
// only fills once a reply comes back, so without this, two triggers firing close together
// (page load + navigation, or a scroll + a retry) both miss the cache and send duplicate
// requests for the same screen. Now the second caller simply waits for the first one's answer.
const pendingScans = new Map();

async function callAPI(text) {
  if (textCache.has(text)) return textCache.get(text);
  if (pendingScans.has(text)) return pendingScans.get(text);

  const request = (async () => {
    // Sent to background.js, which does the actual fetch (and retries) from
    // its own context — not subject to the host page's Content-Security-Policy
    // the way a content script's own fetch() call can be.
    const data = await chrome.runtime.sendMessage({ type: 'VERIFY', text });

    if (!data || data.error) {
      throw new Error(data && data.error ? data.error : 'No response from background script');
    }

    const score = typeof data.score === 'number' ? data.score : 0.5;
    const result = {
      label: score >= 0.7 ? 'green' : score >= 0.4 ? 'amber' : 'red',
      explanation: Array.isArray(data.explanation) ? data.explanation : [data.explanation || ''],
    };

    if (textCache.size >= TEXT_CACHE_MAX) {
      textCache.delete(textCache.keys().next().value);
    }
    textCache.set(text, result);
    saveCacheToSession();
    return result;
  })();

  pendingScans.set(text, request);
  try {
    return await request;
  } finally {
    pendingScans.delete(text);
  }
}

// --- Viewport scan ---

function getContentRoot() {
  // Some sites (news articles) have exactly one article/main container for
  // the whole page. Others (social feeds) have MANY — one per post — so we
  // can't just take the first match; we need whichever one is actually
  // visible in the viewport right now.
  const candidates = document.querySelectorAll('article, main, [role="main"]');
  if (candidates.length === 0) return document.body;
  if (candidates.length === 1) return candidates[0];

  let best = null;
  let bestVisibleHeight = 0;
  candidates.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    if (visibleHeight > bestVisibleHeight) {
      bestVisibleHeight = visibleHeight;
      best = el;
    }
  });
  return best || document.body;
}

function getViewportText() {
  const root = getContentRoot();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node;

  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (text.length < 5) continue;
    const el = node.parentElement;
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.width === 0 && rect.height === 0) continue;
    parts.push(text);
  }

  return [...new Set(parts)].join(' ').slice(0, 3000);
}

// Guards against a stale/older response overwriting a newer, correct one
// when two scans happen to be in flight close together (e.g. the retry-on-
// load scan and a scroll-triggered scan overlapping).
let scanRequestId = 0;

async function updateIndicator() {
  if (!enabled) return; // hard gate: no scan, no API call, no cost, while inactive
  const text = getViewportText();
  if (!text || text.length < 200) return;
  if (text === lastViewportText) return;
  if (lastViewportText && text.slice(0, 500) === lastViewportText.slice(0, 500)) return;

  const thisRequestId = ++scanRequestId;

  try {
    const result = await callAPI(text);
    // Only apply this result if no newer scan has started since — otherwise
    // an older, slower response could overwrite a correct, newer one.
    if (result && thisRequestId === scanRequestId) {
      lastViewportText = text;
      lastResult = result;
      setIndicator(result.label);
      if (panelOpen) buildPanel();
    }
  } catch (err) {
    console.warn('[ScrollSensay]', err.message);
  }
}

let scrollTimer;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(updateIndicator, SCROLL_DEBOUNCE);
}, { passive: true });

// Note: the initial updateIndicator() call happens inside the
// chrome.storage.local.get callback above, once the real `enabled`
// value is known — not here at load time.
