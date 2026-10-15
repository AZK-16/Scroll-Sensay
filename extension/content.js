const SCROLL_DEBOUNCE = 3000;

// Which copy of this file is running? Printed in the page console (F12) on every load,
// so an old or wrong copy of content.js is obvious in seconds.
const BUILD = 'a11y-merge-2';
console.info('[ScrollSensay] content.js loaded, build ' + BUILD);

let enabled = false;
let lastViewportText = '';
let lastResult = { label: null, explanation: [] };
let panelOpen = false;
let pageEpoch = 0; // bumps whenever the user moves to a different page

// --- Indicator dot ---

// A real <button>, so it can be reached with Tab and pressed with Enter or Space,
// and screen readers announce it. The emoji itself is hidden from screen readers;
// the button's aria-label says what it means in words instead.
const indicator = document.createElement('button');
indicator.id = 'hh-indicator';
indicator.type = 'button';
indicator.setAttribute('aria-haspopup', 'dialog');
indicator.setAttribute('aria-expanded', 'false');
indicator.setAttribute('aria-controls', 'hh-panel');
indicator.setAttribute('aria-keyshortcuts', 'Alt+Shift+S');
const indicatorEmoji = document.createElement('span');
indicatorEmoji.setAttribute('aria-hidden', 'true');
indicatorEmoji.textContent = '😊';
indicator.appendChild(indicatorEmoji);
document.body.appendChild(indicator);

const SIGNAL_WORDS = {
  green: 'No concerns found',
  amber: 'Worth a second look',
  red: 'Some concerns here',
  unavailable: "Couldn't check this just now",
};

function setIndicatorLabel(label) {
  const words = SIGNAL_WORDS[label] || 'Still scanning';
  indicator.setAttribute('aria-label', 'ScrollSensay: ' + words + '. Open advice');
}
setIndicatorLabel(null);

function setIndicator(label) {
  indicator.classList.remove('hh-green', 'hh-amber', 'hh-red');
  if (label === 'green')      { indicator.classList.add('hh-green'); indicatorEmoji.textContent = '😊'; }
  else if (label === 'amber') { indicator.classList.add('hh-amber'); indicatorEmoji.textContent = '🤔'; }
  else if (label === 'red')   { indicator.classList.add('hh-red');   indicatorEmoji.textContent = '😧'; }
  else                        {                                       indicatorEmoji.textContent = '😊'; }
  setIndicatorLabel(label);
}

// --- Reasons panel ---

const panel = document.createElement('div');
panel.id = 'hh-panel';
panel.setAttribute('role', 'dialog');
panel.setAttribute('aria-label', "Sensay's advice");
panel.tabIndex = -1; // lets the panel take focus when it opens
document.body.appendChild(panel);

function buildPanel() {
  panel.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'hh-panel-header';

  const titleWrap = document.createElement('div');

  const title = document.createElement('div');
  title.className = 'hh-panel-title';
  title.textContent = lastResult.label === null ? "Sensay's Advice:\nStill scanning…"
    : lastResult.label === 'unavailable' ? "Sensay's Advice:\nCouldn't check this just now"
    : lastResult.label === 'green' ? "Sensay's Advice:\nNo concerns found"
    : lastResult.label === 'amber' ? "Sensay's Advice:\nWorth a second look"
    : "Sensay's Advice:\nSome concerns here";
  title.style.whiteSpace = 'pre-line';
  titleWrap.appendChild(title);
  header.appendChild(titleWrap);

  const audio = document.createElement('button');
  audio.className = 'hh-panel-audio';
  audio.type = 'button';
  audio.innerHTML = '<img src="' + chrome.runtime.getURL('icons/audio-icon.svg') + '" width="18" height="18" alt="" />';
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

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const preferred = [
    'Google UK English Female',
    'Microsoft Sonia Online (Natural) - English (United Kingdom)',
    'Microsoft Libby Online (Natural) - English (United Kingdom)',
    'Google UK English Male',
  ];
  for (const name of preferred) {
    const v = voices.find(v => v.name === name);
    if (v) return v;
  }
  // Basic system voices sound robotic. Higher-quality ones (macOS "Premium"/"Enhanced", Microsoft "Natural")
  // sound much better, so prefer those among the British voices before settling for the first one.
  const british = voices.filter(v => v.lang === 'en-GB' || v.lang === 'en_GB');
  return british.find(v => /premium|enhanced|natural/i.test(v.name))
    || british[0]
    || voices.find(v => (v.lang || '').startsWith('en'))
    || null;
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
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.lang = 'en-GB';
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

// Chrome loads its voice list a moment after the page opens; asking for it
// early makes sure the nicer voices are ready by the first click.
if (window.speechSynthesis) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

function showPanel() {
  buildPanel();
  panel.classList.add('hh-open');
  panelOpen = true;
  indicator.setAttribute('aria-expanded', 'true');
  panel.focus(); // move keyboard and screen-reader focus into the advice
}

function hidePanel(returnFocus) {
  const hadFocus = panel.contains(document.activeElement);
  panel.classList.remove('hh-open');
  panelOpen = false;
  indicator.setAttribute('aria-expanded', 'false');
  if (returnFocus || hadFocus) indicator.focus(); // don't strand keyboard users
}

// Escape closes the advice and puts focus back on the ScrollSensay button.
panel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    hidePanel(true);
  }
});

indicator.addEventListener('click', (e) => {
  e.stopPropagation();
  panelOpen ? hidePanel() : showPanel();
});

document.addEventListener('click', (e) => {
  if (panelOpen && !panel.contains(e.target)) hidePanel();
});

// Keyboard shortcut: Alt+Shift+S (Option+Shift+S on a Mac) opens or closes the advice from anywhere.
// The button sits at the END of the page's Tab order, so without this a keyboard user would have to
// Tab through every link on the page first. It is ignored while typing in a text field.
document.addEventListener('keydown', (e) => {
  if (!enabled || !e.altKey || !e.shiftKey || e.code !== 'KeyS') return;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  e.preventDefault();
  panelOpen ? hidePanel(true) : showPanel();
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
  pageEpoch++; // replies still in flight belong to the previous page, so they won't be shown
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
// Each scan gets a number. A reply is shown unless a NEWER scan's reply has already been shown
// (so a slow, older reply can't overwrite a newer one). Crucially, an older reply is still shown
// if the newer scan hasn't finished or has failed — the user is never left with nothing.
let scanRequestId = 0;
let lastShownRequestId = 0;

function showUnavailableIfEmpty() {
  // Only when nothing is on display yet; never replace a good result with an error.
  if (lastResult.label !== null) return;
  lastResult = { label: 'unavailable', explanation: ["Couldn't check this just now. It will try again when you scroll."] };
  setIndicator('unavailable'); // neutral grey face, and screen readers hear the same words as the panel
  if (panelOpen) buildPanel();
}

async function updateIndicator() {
  if (!enabled) return; // hard gate: no scan, no API call, no cost, while inactive
  const text = getViewportText();
  if (!text || text.length < 200) return;
  if (text === lastViewportText) return;
  if (lastViewportText && text.slice(0, 500) === lastViewportText.slice(0, 500)) return;

  const thisRequestId = ++scanRequestId;
  const epoch = pageEpoch;

  try {
    const result = await callAPI(text);
    // Show it unless the user has since moved to a different page, or a newer scan already showed.
    if (result && epoch === pageEpoch && thisRequestId > lastShownRequestId) {
      lastShownRequestId = thisRequestId;
      lastViewportText = text;
      lastResult = result;
      setIndicator(result.label);
      if (panelOpen) buildPanel();
    }
  } catch (err) {
    console.warn('[ScrollSensay]', err.message);
    if (epoch === pageEpoch) showUnavailableIfEmpty();
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
