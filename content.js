const OVERLAY_ID = "libertas-score-overlay";
const IFRAME_ID = "libertas-score-iframe";
const CONTROL_POPUP_ID = "libertas-overlay-controls";
const REPORT_POPUP_ID = "libertas-incident-popup";
const REPORT_POPUP_VISIBLE_MS = 5000;
const FALLBACK_EXTRA_MS = 1200;
const DEFAULT_SETTINGS = {
  overlayEnabled: true,
};

let settings = { ...DEFAULT_SETTINGS };
let adAudioSession = null;
let adOverlayState = null;
let reportPopupTimeoutId = null;
let reportPopupAdName = "unknown-ad";
let adFallbackTimeoutId = null;

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

function clearAdFallbackTimeout() {
  if (!adFallbackTimeoutId) {
    return;
  }

  clearTimeout(adFallbackTimeoutId);
  adFallbackTimeoutId = null;
}

function scheduleAdFallbackEnd({ adName, durationMs, shouldUnmute }) {
  clearAdFallbackTimeout();

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }

  const fallbackDelayMs = Math.max(1_000, durationMs + FALLBACK_EXTRA_MS);
  adFallbackTimeoutId = setTimeout(() => {
    adFallbackTimeoutId = null;
    hideOverlay();
    endAdVolumeSession();
    adOverlayState = null;

    chrome.runtime.sendMessage({
      type: "REPORT_INCIDENT",
      incidentType: "fallback-timeout",
      adName: adName || "unknown-ad",
      pageUrl: window.location.href,
    });

    chrome.runtime.sendMessage({
      type: "AD_FALLBACK_ENDED",
      adName: adName || "unknown-ad",
      shouldUnmute: shouldUnmute === true,
    });
  }, fallbackDelayMs);
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

function clearReportPopupTimeout() {
  if (!reportPopupTimeoutId) {
    return;
  }

  clearTimeout(reportPopupTimeoutId);
  reportPopupTimeoutId = null;
}

function removeReportPopup() {
  const popup = document.getElementById(REPORT_POPUP_ID);
  if (popup) {
    popup.remove();
  }

  clearReportPopupTimeout();
}

function reportIncident() {
  chrome.runtime.sendMessage({
    type: "REPORT_INCIDENT",
    incidentType: "manual-report-button",
    adName: reportPopupAdName || getAdIdForDisplay(),
    pageUrl: window.location.href,
  });

  removeReportPopup();
}

function goBackNow() {
  hideOverlay();
  endAdVolumeSession();

  chrome.runtime.sendMessage({
    type: "USER_GO_BACK_NOW",
  });
}

function showReportPopup(adName) {
  removeReportPopup();
  reportPopupAdName = adName || "unknown-ad";

  const popup = document.createElement("div");
  popup.id = REPORT_POPUP_ID;
  popup.style.cssText = [
    "position: fixed",
    "right: 20px",
    "bottom: 20px",
    "z-index: 2147483647",
    "width: min(92vw, 340px)",
    "background: rgba(17, 17, 17, 0.94)",
    "color: #fff",
    "border: 1px solid rgba(255, 255, 255, 0.2)",
    "border-radius: 12px",
    "padding: 12px",
    "font-family: system-ui, -apple-system, Segoe UI, sans-serif",
    "box-sizing: border-box",
    "display: flex",
    "flex-direction: column",
    "gap: 10px",
  ].join(";");

  const text = document.createElement("div");
  text.textContent = "If there was a mistake, you can report this incident.";
  text.style.cssText = ["font-size: 13px", "line-height: 1.4"].join(";");

  const adId = document.createElement("div");
  adId.textContent = `Ad id: ${reportPopupAdName}`;
  adId.style.cssText = [
    "font-size: 12px",
    "opacity: 0.85",
    "word-break: break-all",
  ].join(";");

  const actions = document.createElement("div");
  actions.style.cssText = ["display: flex", "justify-content: flex-end"].join(
    ";",
  );

  const reportButton = document.createElement("button");
  reportButton.type = "button";
  reportButton.textContent = "Report incident";
  reportButton.style.cssText = [
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
  reportButton.addEventListener("click", () => {
    reportIncident();
  });

  actions.appendChild(reportButton);
  popup.appendChild(text);
  popup.appendChild(adId);
  popup.appendChild(actions);
  const target = getOverlayMountTarget();
  if (target) {
    target.appendChild(popup);
  }

  reportPopupTimeoutId = setTimeout(() => {
    removeReportPopup();
  }, REPORT_POPUP_VISIBLE_MS);
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

function remountReportPopup() {
  const popup = document.getElementById(REPORT_POPUP_ID);
  if (!popup) {
    return;
  }

  const target = getOverlayMountTarget();
  if (!target) {
    return;
  }

  if (popup.parentElement !== target) {
    target.appendChild(popup);
  }
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

function getScoreUrl() {
  const scoreId = encodeURIComponent(extractScoreIdFromUrl());
  return `https://score.anirudhasah.com/score/${scoreId}`;
}

function ensureOverlay() {
  if (!isHotstarSportsPage()) {
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
    iframe.src = getScoreUrl();

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
  clearAdFallbackTimeout();
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
      iframe.src = getScoreUrl();
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
}

function observeFullscreenChanges() {
  const onFullscreenChange = () => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      remountReportPopup();
      return;
    }

    mountOverlay(overlay);
    remountReportPopup();
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
        typeof message.durationMs === "number" && Number.isFinite(message.durationMs)
          ? Date.now() + Math.max(0, message.durationMs)
          : typeof message.durationSec === "number" &&
              Number.isFinite(message.durationSec)
            ? Date.now() + Math.max(0, message.durationSec) * 1000
          : null,
      tickerId: null,
    };

    showOverlay();
    scheduleAdFallbackEnd({
      adName: message.adName,
      durationMs:
        typeof message.durationMs === "number" && Number.isFinite(message.durationMs)
          ? Math.max(0, message.durationMs)
          : typeof message.durationSec === "number" &&
              Number.isFinite(message.durationSec)
            ? Math.max(0, message.durationSec) * 1000
            : null,
      shouldUnmute: message.shouldUnmute === true,
    });

    if (message.audioMode === "volume") {
      startAdVolumeSession(message.adVolume ?? 30);
    }
  }

  if (message?.type === "AD_ENDED") {
    const lastAdName = adOverlayState?.adName || "unknown-ad";
    hideOverlay();
    endAdVolumeSession();
    adOverlayState = null;

    if (
      message.endReason === "manual-end" ||
      message.endReason === "emergency-timeout"
    ) {
      showReportPopup(lastAdName);
    }
  }

  if (message?.type === "SETTINGS_UPDATED") {
    applySettings(message.settings);
  }
});

loadSettings();
observeRouteChanges();
observeFullscreenChanges();
