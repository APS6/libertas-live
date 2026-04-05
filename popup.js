const DEFAULT_SETTINGS = {
  audioMode: "mute",
  adVolume: 15,
  overlayEnabled: true,
  aggressiveness: "normal",
};

const DEV_MODE = false;

const PRESET_HINTS = {
  relaxed: "Ends the scorecard 100ms before the detected duration.",
  normal: "Ends the scorecard 300ms after the detected duration.",
  aggressive:
    "Ends the scorecard 690ms after the detected duration to prevent early cutoffs.",
  super_aggressive:
    "Ends the scorecard 1s after the detected duration to completely prevent early cutoffs.",
};

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response || {});
    });
  });
}

function clampVolume(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_SETTINGS.adVolume;
  }

  return Math.min(100, Math.max(0, parsed));
}

function normalizeSettings(raw = {}) {
  const audioMode = raw.audioMode === "volume" ? "volume" : "mute";
  const aggressivenessOptions = new Set([
    "relaxed",
    "normal",
    "aggressive",
    "super_aggressive",
  ]);

  return {
    audioMode,
    adVolume: clampVolume(raw.adVolume),
    overlayEnabled: raw.overlayEnabled !== false,
    aggressiveness: aggressivenessOptions.has(raw.aggressiveness)
      ? raw.aggressiveness
      : "normal",
  };
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve(normalizeSettings(result));
    });
  });
}

function setSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set(settings, () => resolve());
  });
}

function initializePopup() {
  const audioMode = document.getElementById("audioMode");
  const adVolume = document.getElementById("adVolume");
  const overlayEnabled = document.getElementById("overlayEnabled");
  const aggressiveness = document.getElementById("aggressiveness");
  const volumeWrap = document.getElementById("volumeWrap");
  const volumeValue = document.getElementById("volumeValue");
  const presetHint = document.getElementById("presetHint");
  const testDuration = document.getElementById("testDuration");
  const testStart = document.getElementById("testStart");
  const testEnd = document.getElementById("testEnd");
  const testStatus = document.getElementById("testStatus");
  const devTools = document.getElementById("devTools");

  const refreshVolumeUi = () => {
    const show = audioMode.value === "volume";
    volumeWrap.hidden = !show;
    volumeValue.textContent = `${adVolume.value}%`;
  };

  const refreshPresetHint = () => {
    presetHint.textContent = PRESET_HINTS[aggressiveness.value] || "";
  };

  const persist = async () => {
    const settings = normalizeSettings({
      audioMode: audioMode.value,
      adVolume: adVolume.value,
      overlayEnabled: overlayEnabled.checked,
      aggressiveness: aggressiveness.value,
    });

    await setSettings(settings);
  };

  const setTestStatus = (message) => {
    testStatus.textContent = message;
  };

  getSettings().then((settings) => {
    audioMode.value = settings.audioMode;
    adVolume.value = String(settings.adVolume);
    overlayEnabled.checked = settings.overlayEnabled;
    aggressiveness.value = settings.aggressiveness;
    refreshVolumeUi();
    refreshPresetHint();
  });

  audioMode.addEventListener("change", async () => {
    refreshVolumeUi();
    await persist();
  });

  adVolume.addEventListener("input", () => {
    volumeValue.textContent = `${clampVolume(adVolume.value)}%`;
  });

  adVolume.addEventListener("change", async () => {
    adVolume.value = String(clampVolume(adVolume.value));
    volumeValue.textContent = `${adVolume.value}%`;
    await persist();
  });

  overlayEnabled.addEventListener("change", persist);

  aggressiveness.addEventListener("change", async () => {
    refreshPresetHint();
    await persist();
  });

  if (DEV_MODE) {
    devTools.hidden = false;

    testStart.addEventListener("click", async () => {
      const rawValue = Number.parseInt(testDuration.value, 10);
      const durationSec = Number.isNaN(rawValue)
        ? 8
        : Math.min(300, Math.max(1, rawValue));
      testDuration.value = String(durationSec);

      try {
        const response = await sendRuntimeMessage({
          type: "TEST_AD_START",
          durationSec,
        });

        setTestStatus(response.message || "Simulated ad start sent.");
      } catch {
        setTestStatus(
          "Failed to start fake ad. Reload the extension and try again.",
        );
      }
    });

    testEnd.addEventListener("click", async () => {
      try {
        const response = await sendRuntimeMessage({ type: "TEST_AD_END" });
        setTestStatus(response.message || "Simulated ad end sent.");
      } catch {
        setTestStatus(
          "Failed to end fake ad. Reload the extension and try again.",
        );
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", initializePopup);
