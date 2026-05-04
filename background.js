/*
Libertas Live
Copyright (C) 2026 Anirudha Pratap Sah
Licensed under GPL v3
*/

const durationRegexes = [
  /_VCTA_(\d{1,3})(?:_|$)/i,
  /(\d{1,3})s(?:Eng(?:lish)?|Hin(?:di)?)/i,
  /(?:^|[_-])(?:HIN|HING|ENG|HINDI|ENGLISH)(?:[_-])[^\d]*(\d{1,3})(?:_|$)/i,
];

const DEFAULT_SETTINGS = {
  audioMode: "mute",
  adVolume: 15,
  overlayEnabled: true,
  aggressiveness: "normal",
};

const PRESET_OFFSET_MS = {
  relaxed: -100,
  normal: 300,
  aggressive: 690,
  super_aggressive: 1000,
};

const DEV_MODE = false;
const SCORE_SERVER_ORIGIN = "https://score.anirudhasah.com";
const MANAGED_MUTE_TABS_KEY = "managedMuteTabs";
const MAX_AD_DURATION_SEC = 50;

function getManagedMuteTabs() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [MANAGED_MUTE_TABS_KEY]: {} }, (result) => {
      const raw = result?.[MANAGED_MUTE_TABS_KEY];
      if (!raw || typeof raw !== "object") {
        resolve({});
        return;
      }

      resolve(raw);
    });
  });
}

function setManagedMuteTabs(nextTabs) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [MANAGED_MUTE_TABS_KEY]: nextTabs }, () => {
      resolve();
    });
  });
}

async function isTabManagedMuted(tabId) {
  const managedTabs = await getManagedMuteTabs();
  return managedTabs[String(tabId)] === true;
}

async function setTabManagedMuted(tabId, managed) {
  const managedTabs = await getManagedMuteTabs();
  const key = String(tabId);

  if (managed) {
    managedTabs[key] = true;
  } else {
    delete managedTabs[key];
  }

  await setManagedMuteTabs(managedTabs);
}

function normalizeSettings(raw = {}) {
  const audioMode = raw.audioMode === "volume" ? "volume" : "mute";
  const adVolume = Number.parseInt(raw.adVolume, 10);
  const aggressiveness = [
    "relaxed",
    "normal",
    "aggressive",
    "super_aggressive",
  ].includes(raw.aggressiveness)
    ? raw.aggressiveness
    : "normal";

  return {
    audioMode,
    adVolume: Number.isNaN(adVolume)
      ? 30
      : Math.min(100, Math.max(0, adVolume)),
    overlayEnabled: raw.overlayEnabled !== false,
    aggressiveness,
  };
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve(normalizeSettings(result));
    });
  });
}

function getAdDurationMs(durationSec, aggressiveness) {
  const baseMs = durationSec * 1000;
  const offsetMs = PRESET_OFFSET_MS[aggressiveness] ?? 0;
  return Math.max(0, baseMs + offsetMs);
}

function normalizeAdDurationSec(rawDurationSec) {
  if (!Number.isFinite(rawDurationSec)) {
    return null;
  }

  return Math.min(MAX_AD_DURATION_SEC, Math.max(1, rawDurationSec));
}

function notifyTab(tabId, type, payload = {}) {
  const message = { type, ...payload };

  chrome.tabs.sendMessage(tabId, message, () => {
    const errorMessage = chrome.runtime.lastError?.message;
    if (!errorMessage) {
      return;
    }

    if (
      errorMessage.includes("Receiving end does not exist") ||
      errorMessage.includes("Could not establish connection")
    ) {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ["content.js"],
        },
        () => {
          if (chrome.runtime.lastError) {
            return;
          }

          chrome.tabs.sendMessage(tabId, message, () => {
            if (chrome.runtime.lastError) {
              // Content script still unavailable for this tab.
            }
          });
        },
      );
    }
  });
}

function notifyAdEndedAndMaybeUnmute(
  tabId,
  adName,
  shouldUnmute,
  endReason = "duration-complete",
) {
  notifyTab(tabId, "AD_ENDED", { adName, endReason });

  maybeUnmuteTab(tabId, shouldUnmute);
}

function maybeUnmuteTab(tabId, shouldUnmute) {
  if (!shouldUnmute) {
    return;
  }

  chrome.tabs.get(tabId, (updatedTab) => {
    if (chrome.runtime.lastError || !updatedTab) {
      return;
    }

    if (updatedTab.mutedInfo?.muted) {
      chrome.tabs.update(tabId, { muted: false }, () => {
        if (chrome.runtime.lastError) {
          return;
        }

        void setTabManagedMuted(tabId, false);
      });
      return;
    }

    void setTabManagedMuted(tabId, false);
  });
}


async function getHotstarTabs() {
  return chrome.tabs.query({ url: "*://*.hotstar.com/*" });
}

async function checkScoreServerUp() {
  try {
    const response = await fetch(`${SCORE_SERVER_ORIGIN}/up`, {
      method: "GET",
      cache: "no-store",
    });

    return response.ok;
  } catch {
    return false;
  }
}

async function startAdHandling({ tabs, adName, durationSec, settings }) {
  if (durationSec == null) {
    return;
  }

  const durationMs = getAdDurationMs(durationSec, settings.aggressiveness);

  for (const tab of tabs) {
    const tabId = tab.id;
    if (tabId == null) {
      continue;
    }

    const isMuted = tab.mutedInfo?.muted;

    if (settings.audioMode === "mute" && !isMuted) {
      chrome.tabs.update(tabId, { muted: true });
      await setTabManagedMuted(tabId, true);
    }

    notifyTab(tabId, "AD_STARTED", {
      adName,
      durationMs,
      audioMode: settings.audioMode,
      adVolume: settings.adVolume,
      overlayEnabled: settings.overlayEnabled,
    });
  }
}

async function endAdHandling({ tabs, adName, endReason = "manual-end" }) {
  for (const tab of tabs) {
    const tabId = tab.id;
    if (tabId == null) {
      continue;
    }

    const wasManagedMuted = await isTabManagedMuted(tabId);
    notifyAdEndedAndMaybeUnmute(
      tabId,
      adName || "manual-end",
      wasManagedMuted,
      endReason,
    );
  }
}

async function notifyTabs(type, payload = {}) {
  const tabs = await getHotstarTabs();
  for (const tab of tabs) {
    if (tab.id != null) {
      notifyTab(tab.id, type, payload);
    }
  }
}

chrome.storage.onChanged.addListener(async (changes) => {
  const relevantKeys = [
    "audioMode",
    "adVolume",
    "overlayEnabled",
    "aggressiveness",
  ];

  const hasRelevantChange = relevantKeys.some((key) => key in changes);
  if (!hasRelevantChange) {
    return;
  }

  const settings = await getSettings();
  await notifyTabs("SETTINGS_UPDATED", { settings });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "USER_GO_BACK_NOW") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, message: "Missing sender tab id." });
        return;
      }

      const wasManagedMuted = await isTabManagedMuted(tabId);
      maybeUnmuteTab(tabId, wasManagedMuted);
      sendResponse({ ok: true });
    })();

    return true;
  }

  if (message?.type === "AD_ENDED_BY_CONTENT") {
    const tabId = sender?.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, message: "Missing sender tab id." });
      return false;
    }

    (async () => {
      const wasManagedMuted = await isTabManagedMuted(tabId);
      maybeUnmuteTab(tabId, wasManagedMuted);
      sendResponse({ ok: true });
    })();

    return true;
  }

  if (message?.type === "TEST_AD_START") {
    if (!DEV_MODE) {
      sendResponse({ ok: false, message: "Dev tools disabled." });
      return false;
    }

    (async () => {
      const tabs = await getHotstarTabs();
      if (tabs.length === 0) {
        sendResponse({
          ok: false,
          message: "Open a Hotstar tab in this window first.",
        });
        return;
      }

      const settings = await getSettings();
      const durationSecRaw = Number.parseInt(message.durationSec, 10);
      const durationSec = normalizeAdDurationSec(
        Number.isNaN(durationSecRaw) ? 8 : durationSecRaw,
      );
      const adName = `TEST_AD_${durationSec}s`;

      await startAdHandling({ tabs, adName, durationSec, settings });
      sendResponse({
        ok: true,
        message: `Simulated ad started (${durationSec}s).`,
      });
    })();

    return true;
  }

  if (message?.type === "TEST_AD_END") {
    if (!DEV_MODE) {
      sendResponse({ ok: false, message: "Dev tools disabled." });
      return false;
    }

    (async () => {
      const tabs = await getHotstarTabs();
      if (tabs.length === 0) {
        sendResponse({
          ok: false,
          message: "Open a Hotstar tab in this window first.",
        });
        return;
      }

      await endAdHandling({
        tabs,
        adName: "TEST_AD_MANUAL_END",
        endReason: "test-manual-end",
      });
      sendResponse({ ok: true, message: "Simulated ad ended." });
    })();

    return true;
  }

  if (message?.type === "CHECK_SCORE_SERVER_UP") {
    (async () => {
      const isUp = await checkScoreServerUp();
      sendResponse({ ok: true, isUp });
    })();

    return true;
  }

  return false;
});

console.log("extension loaded");

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const url = new URL(details.url);
    const adName = url.searchParams.get("adName");
    console.log(`Ad id: ${adName}`);

    if (adName) {
      let durationSec = null;
      for (const regex of durationRegexes) {
        const match = adName.match(regex);
        if (match) {
          durationSec = normalizeAdDurationSec(parseInt(match[1], 10));
          break;
        }
      }

      if (durationSec == null) {
        return;
      }

      const settings = await getSettings();
      const tabs = await getHotstarTabs();
      await startAdHandling({ tabs, adName, durationSec, settings });
    }
  },
  {
    urls: ["*://bifrost-api.hotstar.com/v1/events/track/ct_impression*"],
  },
);
