const OVERLAY_ID = "libertas-score-overlay";
const IFRAME_ID = "libertas-score-iframe";
const DEFAULT_SETTINGS = {
  overlayEnabled: true,
};

let settings = { ...DEFAULT_SETTINGS };
let adAudioSession = null;

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
  return `https://hostb.anirudhasah.com/score/${scoreId}`;
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
      if (document.documentElement) {
        document.documentElement.appendChild(overlay);
      } else {
        requestAnimationFrame(mount);
      }
    };

    mount();

    return { overlay: null, iframe: null };
  }

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
}

function hideOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.style.display = "none";
  }
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "AD_STARTED") {
    if (message.overlayEnabled != null) {
      applySettings({ overlayEnabled: message.overlayEnabled });
    }

    showOverlay();

    if (message.audioMode === "volume") {
      startAdVolumeSession(message.adVolume ?? 30);
    }
  }

  if (message?.type === "AD_ENDED") {
    hideOverlay();
    endAdVolumeSession();
  }

  if (message?.type === "SETTINGS_UPDATED") {
    applySettings(message.settings);
  }
});

loadSettings();
observeRouteChanges();
