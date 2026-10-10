// Service worker — handles the actual network call to the backend.
//
// Content scripts run inside the host page's own context, which means their
// fetch() calls can be blocked by that page's Content-Security-Policy (some
// sites restrict which external addresses a page can send requests to).
// The background service worker runs in the extension's own separate
// context and is never subject to a page's CSP, so routing the API call
// through here avoids that entirely — this is why content.js now sends a
// message here instead of calling fetch() directly.

const USE_LOCAL_BACKEND = false;

// Local development
const LOCAL_API_ENDPOINT = 'http://localhost:8000/api/verify';

// Online backend
const ONLINE_API_ENDPOINT = 'https://scroll-sensay.onrender.com/api/verify';

// Select which backend to use
const API_ENDPOINT = USE_LOCAL_BACKEND
  ? LOCAL_API_ENDPOINT
  : ONLINE_API_ENDPOINT;

async function verifyWithRetry(text, retries = 3) {
  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (res.status === 429) {
    if (retries <= 0) return { error: 'rate_limited' };
    const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return verifyWithRetry(text, retries - 1);
  }

  // Transient upstream failure (e.g. Gemini temporarily overloaded) — retry
  // automatically after a short wait instead of giving up immediately.
  if (res.status === 502 || res.status === 503) {
    if (retries <= 0) return { error: 'upstream_unavailable' };
    await new Promise((r) => setTimeout(r, 4000));
    return verifyWithRetry(text, retries - 1);
  }

  if (!res.ok) return { error: `API ${res.status}` };

  return res.json(); // { score, explanation }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'VERIFY') {
    verifyWithRetry(message.text)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep the message channel open for the async response
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: false }); // opt-in: off until the user turns it on
});
