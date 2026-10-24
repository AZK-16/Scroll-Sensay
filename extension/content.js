// How long to wait after you STOP scrolling before checking what is on screen (milliseconds). Everything else about
// how a check works is unchanged. It was 3000, then 1200 (too many checks, and verdicts changed faster than they could
// be read). Shorter = a verdict sooner but more checks (each costs about 0.1p), because people pause more often than
// they linger. In a scripted reading session: 3000 -> 3 checks, 2200 -> 9, 1800 -> 11, 1200 -> 15.
const SCROLL_DEBOUNCE = 2200;

// Which copy of this file is running? Printed in the page console (F12) on every load,
// so an old or wrong copy of content.js is obvious in seconds.
const BUILD = 'a11y-merge-6-steady-1';
console.info('[ScrollSensay] content.js loaded, build ' + BUILD);

// Messages shown on the grey "no verdict" face.
const MSG_FAILED = "Couldn't check this just now. It will try again when you scroll.";
const MSG_TOO_LITTLE = "Not enough text on screen to check. Scroll to the main story and it will try again.";

let enabled = false;
let lastViewportText = '';
let checkingCue = false; // true while a verdict for the text now on screen is on its way (see setCheckingCue)
let lastViewportHref = ''; // the full address (including the part after #) the verdict on display belongs to
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
// The button is added at the END of the page, which would make it the LAST Tab stop (after every
// link). A tabindex above 0 puts it FIRST in the Tab order instead, so one press of Tab from the top
// of a freshly loaded page reaches it, without moving anything around in the page itself.
indicator.tabIndex = 1;
indicator.setAttribute('aria-haspopup', 'dialog');
indicator.setAttribute('aria-expanded', 'false');
indicator.setAttribute('aria-controls', 'hh-panel');
indicator.setAttribute('aria-keyshortcuts', 'Alt+Shift+S');
const SHORTCUT_MOD = (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '')) ? 'Option' : 'Alt';
indicator.title = 'ScrollSensay: press ' + SHORTCUT_MOD + '+Shift+S from anywhere to open or close the advice';
const indicatorEmoji = document.createElement('span');
indicatorEmoji.setAttribute('aria-hidden', 'true');
indicatorEmoji.textContent = '😊';
indicator.appendChild(indicatorEmoji);

const SIGNAL_WORDS = {
  green: 'No major concerns',
  amber: 'Worth a second look',
  red: 'Some concerns here',
  unavailable: "Couldn't check this just now",
};

function setIndicatorLabel(label) {
  const words = checkingCue ? 'Checking this part of the page' : (SIGNAL_WORDS[label] || 'Still scanning');
  indicator.setAttribute('aria-label', 'ScrollSensay: ' + words + '. Open advice');
}
setIndicatorLabel(null);

function setIndicator(label) {
  ensureMounted();
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
panel.setAttribute('aria-label', "Sensay's advice"); // fallback name while the panel has not been built yet
// Once built, the panel is named by its title ("Sensay's Advice: Some concerns here"), so a screen reader
// announces the verdict as soon as the advice opens instead of just "Sensay's advice, dialog".
panel.setAttribute('aria-labelledby', 'hh-panel-title');
panel.tabIndex = -1; // lets the panel take focus when it opens

// --- Landmark for screen readers ---
// Screen reader users don't move with Tab; they jump between named regions ("landmarks") with
// one key (NVDA/JAWS) or the Landmarks rotor (VoiceOver). This named region lets them jump
// straight to ScrollSensay from anywhere on the page.
// It must not change how the page looks or lays out, so it is deliberately inert:
//  - NOT positioned, so it creates no stacking context and the face/panel keep their very high
//    z-index and stay above the page's own content;
//  - zero height with no margin, padding or border, so it adds no blank space even if the site
//    styles every <div> on the page;
//  - not in the page at all while the extension is switched off, so a screen reader is never told
//    about an empty "ScrollSensay" region (see applyEnabledState).
// It is also never created hidden and revealed later: it goes into the page fully built and already
// visible, in one step, only once we know the extension is ON. (A landmark that is created hidden and
// revealed afterwards was not listed by VoiceOver's Landmarks rotor; one inserted visible was.)
//
// If VoiceOver's Landmarks rotor still does not list ScrollSensay, change this one word to
// 'complementary' (the standard landmark for supporting content), reload the extension and test again.
const LANDMARK_ROLE = 'region';
const landmark = document.createElement('div');
landmark.setAttribute('role', LANDMARK_ROLE);
landmark.setAttribute('aria-label', 'ScrollSensay');
Object.assign(landmark.style, { height: '0', minHeight: '0', margin: '0', padding: '0', border: '0', overflow: 'visible' });
landmark.appendChild(indicator);
landmark.appendChild(panel);
// NOT added to the page here: see applyEnabledState / ensureMounted below.

// FIX 1: some sites (e.g. ok.co.uk, built with React) rebuild the whole page just after it loads,
// which silently deletes our face and panel. Put them back whenever they have gone missing.
// Only while the extension is switched ON, so a switched-off extension never adds anything to a page.
function ensureMounted() {
  if (enabled && !landmark.isConnected && document.body) document.body.appendChild(landmark);
}
// Page rebuilds usually happen in the first few seconds, so check briefly after load...
let mountChecks = 0;
const mountTimer = setInterval(() => {
  ensureMounted();
  if (++mountChecks >= 15) clearInterval(mountTimer); // ~30 seconds, then stop
}, 2000);
// ...and again on every scroll, shortcut press, result and switch-on (see below).

function buildPanel() {
  // If the advice refreshes while someone is inside it (a new verdict arrives), keep their focus in it.
  // Rebuilding the contents would otherwise drop focus back to the page, and a screen reader loses its place.
  const hadFocus = panel.contains(document.activeElement);
  panel.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'hh-panel-header';

  const titleWrap = document.createElement('div');

  const title = document.createElement('div');
  title.className = 'hh-panel-title';
  title.id = 'hh-panel-title'; // names the dialog (see aria-labelledby above)
  title.textContent = checkingCue ? "Sensay's Advice:\nChecking this part of the page…"
    : lastResult.label === null ? "Sensay's Advice:\nStill scanning…"
    : lastResult.label === 'unavailable' ? "Sensay's Advice:\nCouldn't check this just now"
    : lastResult.label === 'green' ? "Sensay's Advice:\nNo major concerns"
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

  if (lastResult.label !== null && !checkingCue) {
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

  if (hadFocus) panel.focus();
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

// Where keyboard focus was just before the advice opened (e.g. a link deep in the article).
let returnFocusTo = null;

function showPanel() {
  const active = document.activeElement;
  returnFocusTo = (active && active !== document.body && active !== panel && !panel.contains(active)) ? active : null;
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
  if (returnFocus || hadFocus) {
    // Put the user back exactly where they were; fall back to the ScrollSensay button if that
    // spot has gone. Either way a keyboard user is never stranded.
    const back = returnFocusTo;
    const canReturn = back && back.isConnected !== false && typeof back.focus === 'function';
    (canReturn ? back : indicator).focus();
  }
  returnFocusTo = null;
}

// Escape closes the advice and puts focus back where the user was.
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
// FIX 6: listen on window in the CAPTURE phase (the `true` at the end), so we hear the key BEFORE the website
// does. Sites with their own shortcuts (e.g. Reddit, Facebook, X) were swallowing it first.
window.addEventListener('keydown', (e) => {
  if (!enabled || !e.altKey || !e.shiftKey || e.code !== 'KeyS') return;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  e.preventDefault();
  e.stopPropagation(); // FIX 6: we have handled it, so the site does not also act on it
  ensureMounted();
  panelOpen ? hidePanel(true) : showPanel();
}, true);

// --- Enabled state (storage-driven, live-updating, opt-in by default) ---

function applyEnabledState() {
  if (!enabled) {
    hidePanel();
    indicator.style.display = 'none';
    if (landmark.isConnected) landmark.remove(); // gone entirely: no empty "ScrollSensay" region for screen readers
    stopChangeWatch(); // while switched off we do not watch the page at all
    clearHeldReply();
    setCheckingCue(false);
  } else {
    indicator.style.display = '';
    ensureMounted(); // inserted already visible, in one step (also restores it if the page deleted it while we were off)
    startChangeWatch();
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
  if (retriesLeft <= 0) { showUnavailableIfEmpty(MSG_TOO_LITTLE); return; } // FIX 2: tell the reader, don't go silent
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
  lastViewportHref = '';
  stashedResult = null;
  lastChangeText = '';
  clearHeldReply();
  setCheckingCue(false);
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

// The verdict that a "not enough text" message replaced, so that it can come straight back (without another
// check, and without cost) if the reader scrolls back to the text it was for.
let stashedResult = null; // { result, text }

// --- Steady verdicts ---------------------------------------------------------------------------------------
// Problem: you scroll on to the next post while the check for the previous one is still running. Its late answer
// used to be shown at once (for text you had already left), and then the right answer replaced it moments later,
// so the face jumped from, say, red to green. Now:
//  - while a check for the screen you are on is on its way, the old verdict is DIMMED and described as "checking";
//  - an answer for a screen you have moved on from is held back for a few seconds instead of flashing up;
//  - if the newest check is slow, the held answer is shown DIMMED after HOLD_OLDER_MS, so there is never just a blank;
//  - if the newest check fails, the held answer is used, as before.
// Nothing here changes what is sent to Gemini or what comes back.
const HOLD_OLDER_MS = 4000;
let heldReply = null; // { id, result, text, href, epoch }
let heldTimer = null;

function setCheckingCue(on) {
  if (on === checkingCue) return;
  checkingCue = on;
  indicator.style.opacity = on ? '0.5' : '';
  indicator.style.filter = on ? 'grayscale(0.85)' : '';
  setIndicatorLabel(lastResult.label); // what screen readers hear stays in step with the face
  if (panelOpen) buildPanel();
}

function clearHeldReply() {
  clearTimeout(heldTimer);
  heldTimer = null;
  heldReply = null;
}

function holdOlderReply(id, result, text, href, epoch) {
  if (heldReply && heldReply.id > id) return; // we already hold a newer one
  clearTimeout(heldTimer);
  heldReply = { id, result, text, href, epoch };
  heldTimer = setTimeout(() => showHeldReply(false), HOLD_OLDER_MS);
}

// `final` = true when the newest check has failed (nothing better is coming), so the held answer is simply shown.
function showHeldReply(final) {
  const h = heldReply;
  clearHeldReply();
  if (!h || h.epoch !== pageEpoch || h.id <= lastShownRequestId) return;
  lastShownRequestId = h.id;
  lastViewportText = h.text;
  lastViewportHref = h.href;
  lastResult = h.result;
  stashedResult = null;
  if (final) setCheckingCue(false); // otherwise it stays dimmed: a newer check is still on its way
  setIndicator(h.result.label);
  if (panelOpen) buildPanel();
}

function showReply(id, result, text, href) {
  clearHeldReply();
  lastShownRequestId = id;
  lastViewportText = text;
  lastViewportHref = href;
  lastResult = result;
  stashedResult = null; // a newer verdict replaces any older one we were holding on to
  setCheckingCue(false);
  setIndicator(result.label);
  if (panelOpen) buildPanel();
}

function sameScreen(a, b) {
  return !!a && !!b && (a === b || a.slice(0, 500) === b.slice(0, 500));
}

// A verdict for text that is no longer on screen is misleading, so when the screen now has too little text to
// check we SAY so, even though an earlier verdict is on display. (Failures to reach the server are different:
// those still never replace a good verdict; see showUnavailableIfEmpty.)
function showTooLittleText() {
  lastShownRequestId = scanRequestId; // replies for screens we have already left must not cover this message
  clearHeldReply();
  setCheckingCue(false);
  if (lastResult.label === 'unavailable' && lastResult.explanation[0] === MSG_TOO_LITTLE) return; // already showing it
  if (lastResult.label && lastResult.label !== 'unavailable') stashedResult = { result: lastResult, text: lastViewportText, href: lastViewportHref };
  lastViewportText = ''; // so the next screen with real text is checked, or the stashed verdict is restored
  lastResult = { label: 'unavailable', explanation: [MSG_TOO_LITTLE] };
  setIndicator('unavailable');
  if (panelOpen) buildPanel();
}

function showUnavailableIfEmpty(message = MSG_FAILED) {
  // Only when nothing is on display yet (or a previous grey message is showing); never replace a real result.
  if (lastResult.label !== null && lastResult.label !== 'unavailable') return;
  lastResult = { label: 'unavailable', explanation: [message] };
  setIndicator('unavailable'); // neutral grey face, and screen readers hear the same words as the panel
  if (panelOpen) buildPanel();
}

async function updateIndicator(givenText) {
  if (!enabled) return; // hard gate: no scan, no API call, no cost, while inactive
  const text = typeof givenText === 'string' ? givenText : getViewportText();
  if (!text || text.length < 200) { showTooLittleText(); return; }
  if (stashedResult && sameScreen(text, stashedResult.text)) {
    // Back on the text the earlier verdict was for: bring that verdict back instead of checking again.
    lastResult = stashedResult.result;
    lastViewportText = stashedResult.text;
    lastViewportHref = stashedResult.href;
    stashedResult = null;
    lastShownRequestId = scanRequestId;
    clearHeldReply();
    setCheckingCue(false);
    setIndicator(lastResult.label);
    if (panelOpen) buildPanel();
    return;
  }
  if (text === lastViewportText || (lastViewportText && text.slice(0, 500) === lastViewportText.slice(0, 500))) {
    // Back on the text the displayed verdict is for: it is current again, and any answers still on their way
    // for screens we passed through are now obsolete.
    lastShownRequestId = scanRequestId;
    clearHeldReply();
    setCheckingCue(false);
    return;
  }
  const thisRequestId = ++scanRequestId;
  const epoch = pageEpoch;
  const href = location.href;
  // A verdict for the PREVIOUS text is still on display: mark it as out of date until the new one arrives.
  if (lastResult.label && lastResult.label !== 'unavailable') setCheckingCue(true);

  try {
    const result = await callAPI(text);
    // Show it unless the user has since moved to a different page, or a newer scan already showed.
    if (result && epoch === pageEpoch && thisRequestId > lastShownRequestId) {
      if (thisRequestId === scanRequestId) showReply(thisRequestId, result, text, href);
      else holdOlderReply(thisRequestId, result, text, href, epoch); // for a screen we have moved on from: hold it back
    }
  } catch (err) {
    console.warn('[ScrollSensay]', err.message);
    if (epoch === pageEpoch) {
      if (thisRequestId === scanRequestId) {
        // The newest check failed: nothing better is coming, so fall back on the best earlier answer (as before).
        if (heldReply) showHeldReply(true);
        setCheckingCue(false);
      }
      showUnavailableIfEmpty();
    }
  }
}

// --- What starts a check -------------------------------------------------------------------------------------
// 1) Scrolling. We listen in the CAPTURE phase because scroll events do not bubble: apps like webmail scroll an
//    inner pane, whose scroll events never reach a normal window listener. Small scrollers (a code box, a
//    carousel, a text field) and our own advice panel are ignored, so they cannot keep postponing a check.
let scrollTimer;
let lastScrollAt = 0;
window.addEventListener('scroll', (e) => {
  const t = e.target;
  if (t && t !== document && t.nodeType === 1) {
    if (landmark.contains(t)) return;
    if (t.clientWidth * t.clientHeight < 0.2 * window.innerWidth * window.innerHeight) return;
  }
  lastScrollAt = Date.now();
  ensureMounted(); // FIX 1
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => settleThenCheck(getViewportText(), 0), Math.max(0, SCROLL_DEBOUNCE - SETTLE_LOOK_MS));
}, { passive: true, capture: true });

// Before sending a check, make sure the text has STOPPED changing (a post still loading its text or images would
// otherwise be checked half-finished, then again when it finishes). We look once near the end of the pause and once
// at the end of it; if both agree, go. So there is no extra wait unless the page really is still changing, and then
// at most two more half-seconds.
const SETTLE_LOOK_MS = 500;
function settleThenCheck(before, tries) {
  scrollTimer = setTimeout(() => {
    const now = getViewportText();
    if (now === before || tries >= 2) updateIndicator(now);
    else settleThenCheck(now, tries + 1);
  }, SETTLE_LOOK_MS);
}

// 2) The text on screen changing WITHOUT any scrolling: opening the next email, clicking to another post, a
//    view that finishes loading. Nothing announces that, and apps that route with #hash do not even count as a
//    page change, so previously nothing happened until something else prodded us. We now look when the page
//    changes shortly after the reader clicked, typed, tapped or scrolled. The look itself is cheap and heavily
//    rate-limited, and a check (which costs money) still only starts if the text on screen is really new.
const INPUT_WINDOW_MS = 10000;   // only react to changes this soon after the reader did something
const CHANGE_SETTLE_MS = 800;    // let a change finish (an email body still loading) before looking
const CHANGE_MAX_WAIT_MS = 3000; // ...but never wait longer than this on a page that keeps changing
const CHANGE_MIN_GAP_MS = 2500;  // and look at most this often
const CHANGE_SCANS_PER_MINUTE = 10; // hard ceiling on checks started this way (a page that rewrites itself non-stop)

let lastInputAt = 0;
let lastChangeRunAt = 0;
let lastChangeText = '';
let changeScanTimes = [];
let changeTimer = null;
let changePendingSince = 0;
let changeObserver = null;

['click', 'keydown', 'pointerdown', 'touchstart', 'wheel'].forEach((type) => {
  window.addEventListener(type, () => { lastInputAt = Date.now(); }, { capture: true, passive: true });
});

// True if two screens of text are essentially the same (a clock, a counter or a "2 min ago" changed, not the content):
// nine in ten distinct words are shared. Used ONLY for changes nobody scrolled to; scrolling uses the original rule.
function mostlySame(a, b) {
  if (!a || !b) return false;
  const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  wa.forEach((w) => { if (wb.has(w)) shared++; });
  return shared / (wa.size + wb.size - shared) >= 0.9;
}

function scheduleChangeCheck() {
  const now = Date.now();
  if (!changePendingSince) changePendingSince = now;
  clearTimeout(changeTimer);
  const settle = Math.min(CHANGE_SETTLE_MS, Math.max(0, changePendingSince + CHANGE_MAX_WAIT_MS - now));
  changeTimer = setTimeout(runChangeCheck, Math.max(settle, lastChangeRunAt + CHANGE_MIN_GAP_MS - now));
}

function runChangeCheck() {
  changeTimer = null;
  changePendingSince = 0;
  lastChangeRunAt = Date.now();
  if (!enabled || document.visibilityState !== 'visible') return;
  if (Date.now() - lastScrollAt < SCROLL_DEBOUNCE) return; // mid-scroll: the scroll handler checks when it stops
  const text = getViewportText();
  if (text === lastChangeText) return; // nothing different on screen since we last looked
  lastChangeText = text;
  // Webmail and similar apps change the part after the # for every email. If the address is no longer the one the
  // verdict on display belongs to, this is a different item, so never dismiss it as "the same content" (the check
  // below still skips it if the top of the screen is unchanged, and the cost ceiling still applies).
  const addressChanged = location.href !== lastViewportHref;
  if (text.length >= 200 && !addressChanged && mostlySame(text, lastViewportText)) return;
  if (text.length >= 200) {
    const now = Date.now();
    changeScanTimes = changeScanTimes.filter((t) => now - t < 60000);
    if (changeScanTimes.length >= CHANGE_SCANS_PER_MINUTE) { lastChangeText = ''; return; } // cost ceiling: look again later
    changeScanTimes.push(now);
  }
  updateIndicator(text);
}

function startChangeWatch() {
  if (!changeObserver) {
    changeObserver = new MutationObserver((records) => {
      if (!enabled || Date.now() - lastInputAt > INPUT_WINDOW_MS) return;
      if (records.every((r) => landmark.contains(r.target))) return; // only our own widget changed
      scheduleChangeCheck();
    });
  }
  changeObserver.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'class', 'style', 'aria-hidden'],
  });
}

function stopChangeWatch() {
  if (changeObserver) changeObserver.disconnect();
  clearTimeout(changeTimer);
  changeTimer = null;
  changePendingSince = 0;
}

// Note: the initial updateIndicator() call happens inside the
// chrome.storage.local.get callback above, once the real `enabled`
// value is known — not here at load time.
