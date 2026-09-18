// Service worker — currently a placeholder.
// Add message listeners here if you need to route API calls
// through the background (e.g. to hide the API key from content scripts).

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: false }); // opt-in: off until the user turns it on
});