chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#C2410C" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "SET_BADGE") {
    return false;
  }

  const count = Number(message.count || 0);
  chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#C2410C" });
  sendResponse({ ok: true });
  return true;
});
