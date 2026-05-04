/*
Libertas Live
Copyright (C) 2026 Anirudha Pratap Sah
Licensed under GPL v3
*/

const OVERLAY_ID = "libertas-score-overlay";
const IFRAME_ID = "libertas-score-iframe";
const CONTROL_POPUP_ID = "libertas-overlay-controls";
const VIEWER_ID_STORAGE_KEY = "viewerId";
const SCORE_SERVER_ORIGIN = "https://score.anirudhasah.com";
const SCORE_SERVER_UP_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SCORE_SERVER_DOWN_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const SCORE_SERVER_DOWN_MESSAGE_ID = "libertas-score-down-message";
const DEFAULT_SETTINGS = {
  overlayEnabled: true,
};

let settings = { ...DEFAULT_SETTINGS };
let adAudioSession = null;
let adOverlayState = null;
let adEndTimeoutId = null;
let viewerIdPromise = null;
let scoreServerCheckIntervalId = null;
let scoreServerCheckIntervalMs = null;
let scoreServerAvailabilityCheckPromise = null;
let scoreServerInitialCheckCompleted = false;
let scoreServerIsUp = null;
let scoreServerCheckedForScoreId = null;

function generateViewerId() {
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateViewerId() {
  if (viewerIdPromise) {
    return viewerIdPromise;
  }

  viewerIdPromise = new Promise((resolve) => {
    chrome.storage.local.get({ [VIEWER_ID_STORAGE_KEY]: null }, (result) => {
      const existingId = result?.[VIEWER_ID_STORAGE_KEY];
      if (typeof existingId === "string" && existingId.length > 0) {
        resolve(existingId);
        return;
      }

      const nextId = generateViewerId();
      chrome.storage.local.set({ [VIEWER_ID_STORAGE_KEY]: nextId }, () => {
        resolve(nextId);
      });
    });
  });

  return viewerIdPromise;
}

function formatSecondsRemaining(secondsRemaining) {
  const safeSeconds = Math.max(0, Math.ceil(secondsRemaining));
  return safeSeconds;
}

function getAdIdForDisplay() {
  return adOverlayState?.adName || "unknown-ad";
}

function clearAdOverlayTicker() {
  if (!adOverlayState?.tickerId) {
    return;
  }

  clearInterval(adOverlayState.tickerId);
  adOverlayState.tickerId = null;
}

function clearAdEndTimeout() {
  if (!adEndTimeoutId) {
    return;
  }

  clearTimeout(adEndTimeoutId);
  adEndTimeoutId = null;
}

function scheduleAdEndFromContent({ durationMs }) {
  clearAdEndTimeout();

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }

  adEndTimeoutId = setTimeout(() => {
    adEndTimeoutId = null;
    hideOverlay();
    endAdVolumeSession();
    adOverlayState = null;

    chrome.runtime.sendMessage({
      type: "AD_ENDED_BY_CONTENT",
    });
  }, durationMs);
}

function removeControlPopup() {
  const existingPopup = document.getElementById(CONTROL_POPUP_ID);
  if (existingPopup) {
    existingPopup.remove();
  }
}

function teardownAdOverlayUi() {
  clearAdOverlayTicker();
  removeControlPopup();
}


function goBackNow() {
  clearAdEndTimeout();
  hideOverlay();
  endAdVolumeSession();
  adOverlayState = null;

  chrome.runtime.sendMessage({
    type: "USER_GO_BACK_NOW",
  });
}

function updateCountdownLabel(label) {
  if (!adOverlayState?.endAt) {
    label.textContent = "Going back in 0 sec";
    return;
  }

  const secondsRemaining = (adOverlayState.endAt - Date.now()) / 1000;
  label.textContent = `Going back in ${formatSecondsRemaining(secondsRemaining)} sec`;
}

function ensureControlPopup() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    return;
  }

  let popup = document.getElementById(CONTROL_POPUP_ID);
  if (!popup) {
    popup = document.createElement("div");
    popup.id = CONTROL_POPUP_ID;
    popup.style.cssText = [
      "position: absolute",
      "right: 20px",
      "bottom: 20px",
      "z-index: 2",
      "width: min(92vw, 340px)",
      "background: rgba(17, 17, 17, 0.9)",
      "backdrop-filter: blur(6px)",
      "color: #fff",
      "border: 1px solid rgba(255, 255, 255, 0.16)",
      "border-radius: 12px",
      "padding: 14px",
      "display: flex",
      "align-items: center",
      "gap: 10px",
      "font-family: system-ui, -apple-system, Segoe UI, sans-serif",
      "box-sizing: border-box",
    ].join(";");

    const countdown = document.createElement("div");
    countdown.id = `${CONTROL_POPUP_ID}-countdown`;
    countdown.style.cssText = [
      "font-size: 14px",
      "font-weight: 500",
      "white-space: nowrap",
      "margin-right: auto",
    ].join(";");

    const goBackButton = document.createElement("button");
    goBackButton.type = "button";
    goBackButton.textContent = "Go back now";
    goBackButton.style.cssText = [
      "appearance: none",
      "border: 0",
      "border-radius: 8px",
      "padding: 8px 10px",
      "font-size: 13px",
      "font-weight: 500",
      "cursor: pointer",
      "background: #f2f2f2",
      "color: #111",
    ].join(";");
    goBackButton.addEventListener("click", goBackNow);

    popup.appendChild(countdown);
    popup.appendChild(goBackButton);
    overlay.appendChild(popup);
  }

  const countdownLabel = document.getElementById(
    `${CONTROL_POPUP_ID}-countdown`,
  );
  if (!(countdownLabel instanceof HTMLElement)) {
    return;
  }

  updateCountdownLabel(countdownLabel);
  clearAdOverlayTicker();
  const tickerId = setInterval(() => updateCountdownLabel(countdownLabel), 250);
  if (!adOverlayState) {
    adOverlayState = { adName: "unknown-ad", endAt: null, tickerId };
  } else {
    adOverlayState.tickerId = tickerId;
  }
}

function getOverlayMountTarget() {
  if (document.fullscreenElement instanceof Element) {
    return document.fullscreenElement;
  }

  return document.documentElement;
}

function mountOverlay(overlay) {
  const target = getOverlayMountTarget();
  if (!target) {
    return false;
  }

  if (overlay.parentElement !== target) {
    target.appendChild(overlay);
  }

  return true;
}


function extractScoreIdFromUrl() {
  const url = new URL(window.location.href);
  const segments = url.pathname.split("/");

  const vsPattern = /^[a-z0-9]+-vs-[a-z0-9-]+$/i;

  for (const segment of segments) {
    if (vsPattern.test(segment)) {
      return segment;
    }
  }

  return "unknown";
}

function isHotstarSportsPage() {
  return /\/in\/sports\//i.test(window.location.pathname);
}

async function getScoreUrl() {
  const scoreId = encodeURIComponent(extractScoreIdFromUrl());
  const viewerId = encodeURIComponent(await getOrCreateViewerId());
  return `${SCORE_SERVER_ORIGIN}/score/${scoreId}?viewer=${viewerId}`;
}

async function syncIframeScoreUrl(iframe, { forceReload = false } = {}) {
  if (!iframe) {
    return;
  }

  const scoreUrl = await getScoreUrl();
  if (forceReload || iframe.src !== scoreUrl) {
    iframe.src = scoreUrl;
  }
}

function stopScoreServerChecks() {
  if (!scoreServerCheckIntervalId) {
    return;
  }

  clearInterval(scoreServerCheckIntervalId);
  scoreServerCheckIntervalId = null;
  scoreServerCheckIntervalMs = null;
}

function getScoreServerCheckIntervalMs() {
  return scoreServerIsUp === false
    ? SCORE_SERVER_DOWN_CHECK_INTERVAL_MS
    : SCORE_SERVER_UP_CHECK_INTERVAL_MS;
}

function ensureScoreServerChecks(iframe) {
  const nextIntervalMs = getScoreServerCheckIntervalMs();

  if (
    scoreServerCheckIntervalId &&
    scoreServerCheckIntervalMs === nextIntervalMs
  ) {
    return;
  }

  if (scoreServerCheckIntervalId) {
    clearInterval(scoreServerCheckIntervalId);
  }

  scoreServerCheckIntervalMs = nextIntervalMs;
  scoreServerCheckIntervalId = setInterval(() => {
    void syncIframeAvailability(iframe, { forceCheck: true });
  }, nextIntervalMs);
}

function ensureScoreServerDownMessage(overlay) {
  let message = document.getElementById(SCORE_SERVER_DOWN_MESSAGE_ID);
  if (message) {
    return message;
  }

  message = document.createElement("div");
  message.id = SCORE_SERVER_DOWN_MESSAGE_ID;
  message.style.cssText = [
    "position: absolute",
    "inset: 0",
    "display: none",
    "align-items: center",
    "justify-content: center",
    "text-align: center",
    "padding: 24px",
    "box-sizing: border-box",
    "color: #fff",
    "font-size: 22px",
    "font-weight: 600",
    "font-family: system-ui, -apple-system, Segoe UI, sans-serif",
    "line-height: 1.4",
    "background: #000",
  ].join(";");
  message.textContent =
    "Score server is offline but we'll hopefully be back soon!";
  overlay.appendChild(message);
  return message;
}

function setScoreServerAvailabilityUi({ overlay, iframe, isUp }) {
  if (!overlay || !iframe) {
    return;
  }

  const downMessage = ensureScoreServerDownMessage(overlay);
  if (isUp) {
    iframe.style.display = "block";
    downMessage.style.display = "none";
    return;
  }

  iframe.style.display = "none";
  downMessage.style.display = "flex";
}

function checkScoreServerUp() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "CHECK_SCORE_SERVER_UP" },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }

        resolve(response?.isUp === true);
      },
    );
  });
}

function syncIframeForCurrentAvailability(
  iframe,
  { forceReload = false } = {},
) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (scoreServerIsUp === false) {
    setScoreServerAvailabilityUi({ overlay, iframe, isUp: false });
    ensureScoreServerChecks(iframe);
    return;
  }

  setScoreServerAvailabilityUi({ overlay, iframe, isUp: true });
  ensureScoreServerChecks(iframe);
  void syncIframeScoreUrl(iframe, { forceReload });
}

async function syncIframeAvailability(iframe, { forceCheck = false } = {}) {
  if (!iframe) {
    return;
  }

  const currentScoreId = extractScoreIdFromUrl();
  if (scoreServerCheckedForScoreId !== currentScoreId) {
    scoreServerCheckedForScoreId = currentScoreId;
    scoreServerInitialCheckCompleted = false;
    scoreServerIsUp = null;
  }

  if (scoreServerInitialCheckCompleted && !forceCheck) {
    syncIframeForCurrentAvailability(iframe);
    return;
  }

  if (scoreServerAvailabilityCheckPromise) {
    await scoreServerAvailabilityCheckPromise;
    return;
  }

  scoreServerAvailabilityCheckPromise = (async () => {
    const wasUp = scoreServerIsUp === true;
    const isUp = await checkScoreServerUp();
    scoreServerInitialCheckCompleted = true;
    scoreServerIsUp = isUp;
    const becameUp = !wasUp && isUp;

    syncIframeForCurrentAvailability(iframe, { forceReload: becameUp });
  })();

  try {
    await scoreServerAvailabilityCheckPromise;
  } finally {
    scoreServerAvailabilityCheckPromise = null;
  }
}

function ensureOverlay() {
  if (!isHotstarSportsPage()) {
    stopScoreServerChecks();
    return { overlay: null, iframe: null };
  }

  let overlay = document.getElementById(OVERLAY_ID);
  let iframe = document.getElementById(IFRAME_ID);

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      "position: fixed",
      "inset: 0",
      "width: 100vw",
      "height: 100vh",
      "z-index: 9999999999",
      "display: none",
      "background: #000",
    ].join(";");

    iframe = document.createElement("iframe");
    iframe.id = IFRAME_ID;
    iframe.allow = "autoplay; fullscreen";
    iframe.style.cssText = [
      "border: 0",
      "width: 100%",
      "height: 100%",
      "display: block",
      "background: #000",
    ].join(";");
    void syncIframeAvailability(iframe);

    overlay.appendChild(iframe);

    const mount = () => {
      if (mountOverlay(overlay)) {
        return;
      } else {
        requestAnimationFrame(mount);
      }
    };

    mount();

    return { overlay: null, iframe: null };
  }

  if (iframe) {
    void syncIframeAvailability(iframe);
  }

  mountOverlay(overlay);

  return { overlay, iframe };
}

function showOverlay() {
  if (!settings.overlayEnabled) {
    return;
  }

  const revealOverlay = () => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.style.display = "block";
      return;
    }

    requestAnimationFrame(revealOverlay);
  };

  ensureOverlay();
  revealOverlay();
  ensureControlPopup();
}

function hideOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.style.display = "none";
  }

  teardownAdOverlayUi();
}

function getMediaElements() {
  return Array.from(document.querySelectorAll("video, audio"));
}

function startAdVolumeSession(volumePercent) {
  const mediaElements = getMediaElements();
  if (mediaElements.length === 0) {
    return;
  }

  if (!adAudioSession) {
    adAudioSession = {
      snapshots: mediaElements.map((element) => ({
        element,
        volume: element.volume,
        muted: element.muted,
      })),
    };
  }

  const targetVolume = Math.min(1, Math.max(0, volumePercent / 100));
  for (const element of mediaElements) {
    element.muted = false;
    element.volume = targetVolume;
  }
}

function endAdVolumeSession() {
  if (!adAudioSession) {
    return;
  }

  for (const snapshot of adAudioSession.snapshots) {
    if (!snapshot.element || !snapshot.element.isConnected) {
      continue;
    }

    snapshot.element.volume = snapshot.volume;
    snapshot.element.muted = snapshot.muted;
  }

  adAudioSession = null;
}

function normalizeSettings(raw = {}) {
  return {
    overlayEnabled: raw.overlayEnabled !== false,
  };
}

function applySettings(nextSettings) {
  settings = normalizeSettings(nextSettings);
  if (!settings.overlayEnabled) {
    hideOverlay();
  }
}

function loadSettings() {
  chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
    applySettings(result);
    ensureOverlay();
  });
}

function observeRouteChanges() {
  let lastHref = window.location.href;

  const onRouteChange = () => {
    if (window.location.href === lastHref) {
      return;
    }

    lastHref = window.location.href;
    const { iframe } = ensureOverlay();
    if (iframe) {
      void syncIframeAvailability(iframe);
    }
  };

  const originalPushState = history.pushState;
  history.pushState = function patchedPushState(...args) {
    const result = originalPushState.apply(this, args);
    onRouteChange();
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function patchedReplaceState(...args) {
    const result = originalReplaceState.apply(this, args);
    onRouteChange();
    return result;
  };

  window.addEventListener("popstate", onRouteChange);

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) {
      return;
    }

    lastHref = "";
    onRouteChange();
  });
}

function observeFullscreenChanges() {
  const onFullscreenChange = () => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      return;
    }

    mountOverlay(overlay);
  };

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "AD_STARTED") {
    if (message.overlayEnabled != null) {
      applySettings({ overlayEnabled: message.overlayEnabled });
    }

    adOverlayState = {
      adName: message.adName || "unknown-ad",
      endAt:
        typeof message.durationMs === "number" &&
        Number.isFinite(message.durationMs)
          ? Date.now() + Math.max(0, message.durationMs)
          : null,
      tickerId: null,
    };

    showOverlay();
    scheduleAdEndFromContent({
      durationMs:
        typeof message.durationMs === "number" &&
        Number.isFinite(message.durationMs)
          ? Math.max(0, message.durationMs)
          : null,
    });

    if (message.audioMode === "volume") {
      startAdVolumeSession(message.adVolume ?? 30);
    }
  }

  if (message?.type === "AD_ENDED") {
    clearAdEndTimeout();
    hideOverlay();
    endAdVolumeSession();
    adOverlayState = null;
  }

  if (message?.type === "SETTINGS_UPDATED") {
    applySettings(message.settings);
  }
});

loadSettings();
void getOrCreateViewerId();
observeRouteChanges();
observeFullscreenChanges();
