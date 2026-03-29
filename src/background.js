const durationRegexes = [
  /(\d{1,3})s(?:Eng(?:lish)?|Hin(?:di)?)/i,
  /(?:HIN|ENG|HINDI|ENGLISH)[^\d]*(\d{1,3})/i,
];

const unmuteTimeouts = new Map();

function notifyTab(tabId, type, payload = {}) {
  chrome.tabs.sendMessage(tabId, { type, ...payload }, () => {
    if (chrome.runtime.lastError) {
      // No active content script in this tab or tab changed.
    }
  });
}

console.log("Hotstar Adblocker extension loaded");

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const url = new URL(details.url);
    const adName = url.searchParams.get("adName");
    console.log(`Ad id: ${adName}`);

    if (adName) {
      let durationSec = 10;
      for (const regex of durationRegexes) {
        const match = adName.match(regex);
        if (match) {
          durationSec = parseInt(match[1], 10);
          break;
        }
      }

      console.log(`Muting ${adName} for ${durationSec} seconds`);

      const tabs = await chrome.tabs.query({ url: "*://*.hotstar.com/*" });

      for (const tab of tabs) {
        const tabId = tab.id;
        if (tabId == null) {
          continue;
        }

        const isMuted = tab.mutedInfo?.muted;

        notifyTab(tabId, "AD_STARTED", { adName, durationSec });

        if (!isMuted) {
          chrome.tabs.update(tabId, { muted: true });
          console.log(`Muted tab ${tabId}`);
        }

        const existingTimeout = unmuteTimeouts.get(tabId);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
        }

        const timeoutId = setTimeout(() => {
          unmuteTimeouts.delete(tabId);
          chrome.tabs.get(tabId, (updatedTab) => {
            if (chrome.runtime.lastError || !updatedTab) {
              return;
            }

            if (updatedTab.mutedInfo?.muted) {
              chrome.tabs.update(tabId, { muted: false });
              notifyTab(tabId, "AD_ENDED", { adName });
              console.log(`Unmuted tab ${tabId}`);
            }
          });
        }, durationSec * 1000);

        unmuteTimeouts.set(tabId, timeoutId);
      }
    }
  },
  {
    urls: ["*://bifrost-api.hotstar.com/v1/events/track/ct_impression*"],
  },
);
