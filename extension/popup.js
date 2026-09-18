const toggle = document.getElementById('enabledToggle');

chrome.storage.local.get(['enabled'], (result) => {
  toggle.checked = result.enabled === true; // opt-in: matches content.js and background.js
});

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});