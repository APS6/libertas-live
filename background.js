const durationRegexes = [
  /(\d{1,3})s(?:Eng(?:lish)?|Hin(?:di)?)/i,
  /(?:HIN|ENG|HINDI|ENGLISH)[^\d]*(\d{1,3})/i,
];

const DEFAULT_SETTINGS = {
  audioMode: "mute",
  adVolume: 15,
  overlayEnabled: true,
  aggressiveness: "aggressive",
};

const PRESET_OFFSET_MS = {
  relaxed: -100,
  normal: 100,
  aggressive: 300,
};

const DEV_MODE = false;
const EMERGENCY_EXIT_MS = 45_000;

const unmuteTimeouts = new Map();

function normalizeSettings(raw = {}) {
  const audioMode = raw.audioMode === "volume" ? "volume" : "mute";
  const adVolume = Number.parseInt(raw.adVolume, 10);
  const aggressiveness = ["relaxed", "normal", "aggressive"].includes(
    raw.aggressiveness,
  )
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

function clearAdTimeout(tabId) {
  const existingTimeout = unmuteTimeouts.get(tabId);
  if (!existingTimeout) {
    return null;
  }

  clearTimeout(existingTimeout.timeoutId);
  clearTimeout(existingTimeout.emergencyTimeoutId);
  unmuteTimeouts.delete(tabId);
  return existingTimeout;
}

function notifyAdEndedAndMaybeUnmute(
  tabId,
  adName,
  shouldUnmute,
  endReason = "duration-complete",
) {
  notifyTab(tabId, "AD_ENDED", { adName, endReason });

  if (!shouldUnmute) {
    return;
  }

  chrome.tabs.get(tabId, (updatedTab) => {
    if (chrome.runtime.lastError || !updatedTab) {
      return;
    }

    if (updatedTab.mutedInfo?.muted) {
      chrome.tabs.update(tabId, { muted: false });
    }
  });
}

function buildIncidentReportPayload({ adName, pageUrl }) {
  return {
    adName: adName || "unknown-ad",
    pageUrl: pageUrl || "unknown-page",
    timestamp: new Date().toISOString(),
  };
}

async function submitIncidentReport(payload) {
  const response = await fetch(
    "https://score.anirudhasah.com/api/incident-reports",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(`Incident report failed with status ${response.status}`);
  }
}

async function getHotstarTabs() {
  return chrome.tabs.query({ url: "*://*.hotstar.com/*" });
}

async function getActiveHotstarTabs() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.filter((tab) => {
    if (!tab.url) {
      return false;
    }

    try {
      return new URL(tab.url).hostname.endsWith("hotstar.com");
    } catch {
      return false;
    }
  });
}

async function startAdHandling({ tabs, adName, durationSec, settings }) {
  const durationMs = getAdDurationMs(durationSec, settings.aggressiveness);

  for (const tab of tabs) {
    const tabId = tab.id;
    if (tabId == null) {
      continue;
    }

    const previousTimeout = clearAdTimeout(tabId);
    let shouldUnmute = previousTimeout?.shouldUnmute ?? false;
    const isMuted = tab.mutedInfo?.muted;

    notifyTab(tabId, "AD_STARTED", {
      adName,
      durationSec,
      audioMode: settings.audioMode,
      adVolume: settings.adVolume,
      overlayEnabled: settings.overlayEnabled,
    });

    if (settings.audioMode === "mute" && !isMuted) {
      chrome.tabs.update(tabId, { muted: true });
      shouldUnmute = true;
    }

    const timeoutId = setTimeout(() => {
      const activeTimeout = unmuteTimeouts.get(tabId);
      if (!activeTimeout || activeTimeout.timeoutId !== timeoutId) {
        return;
      }

      unmuteTimeouts.delete(tabId);
      notifyAdEndedAndMaybeUnmute(
        tabId,
        activeTimeout.adName,
        activeTimeout.shouldUnmute,
        "duration-complete",
      );
    }, durationMs);

    const emergencyTimeoutId = setTimeout(() => {
      const activeTimeout = unmuteTimeouts.get(tabId);
      if (
        !activeTimeout ||
        activeTimeout.timeoutId !== timeoutId ||
        activeTimeout.emergencyTimeoutId !== emergencyTimeoutId
      ) {
        return;
      }

      unmuteTimeouts.delete(tabId);
      notifyAdEndedAndMaybeUnmute(
        tabId,
        activeTimeout.adName,
        activeTimeout.shouldUnmute,
        "emergency-timeout",
      );
    }, EMERGENCY_EXIT_MS);

    unmuteTimeouts.set(tabId, {
      timeoutId,
      emergencyTimeoutId,
      shouldUnmute,
      adName,
    });
  }
}

async function endAdHandling({ tabs, adName, endReason = "manual-end" }) {
  for (const tab of tabs) {
    const tabId = tab.id;
    if (tabId == null) {
      continue;
    }

    const previousTimeout = clearAdTimeout(tabId);
    notifyAdEndedAndMaybeUnmute(
      tabId,
      adName || previousTimeout?.adName || "manual-end",
      previousTimeout?.shouldUnmute ?? false,
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

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "USER_GO_BACK_NOW") {
    (async () => {
      const tabs = await getActiveHotstarTabs();
      if (tabs.length === 0) {
        sendResponse({ ok: false, message: "No active Hotstar tab found." });
        return;
      }

      await endAdHandling({ tabs, endReason: "manual-end" });
      sendResponse({ ok: true });
    })();

    return true;
  }

  if (message?.type === "REPORT_INCIDENT") {
    const payload = buildIncidentReportPayload({
      adName: message.adName,
      pageUrl: message.pageUrl,
    });

    (async () => {
      try {
        await submitIncidentReport(payload);
        sendResponse({ ok: true });
      } catch (error) {
        console.error("Failed to submit incident report", error);
        sendResponse({
          ok: false,
          message: "Failed to submit incident report.",
        });
      }
    })();

    return true;
  }

  if (message?.type === "TEST_AD_START") {
    if (!DEV_MODE) {
      sendResponse({ ok: false, message: "Dev tools disabled." });
      return false;
    }

    (async () => {
      const tabs = await getActiveHotstarTabs();
      if (tabs.length === 0) {
        sendResponse({
          ok: false,
          message: "Open a Hotstar tab in this window first.",
        });
        return;
      }

      const settings = await getSettings();
      const durationSecRaw = Number.parseInt(message.durationSec, 10);
      const durationSec = Number.isNaN(durationSecRaw)
        ? 8
        : Math.min(300, Math.max(1, durationSecRaw));
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
      const tabs = await getActiveHotstarTabs();
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

  return false;
});

console.log("extension loaded");

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

      const settings = await getSettings();
      const tabs = await getHotstarTabs();
      await startAdHandling({ tabs, adName, durationSec, settings });
    }
  },
  {
    urls: ["*://bifrost-api.hotstar.com/v1/events/track/ct_impression*"],
  },
);
