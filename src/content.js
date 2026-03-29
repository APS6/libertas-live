const OVERLAY_ID = "libertas-score-overlay";
const IFRAME_ID = "libertas-score-iframe";

function extractScoreIdFromUrl() {
  const url = new URL(window.location.href);

  const queryKeys = ["id", "matchId", "contentId", "cid"];
  for (const key of queryKeys) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }

  const ignoredSegments = new Set([
    "",
    "in",
    "sports",
    "cricket",
    "video",
    "live",
    "watch",
  ]);

  const segments = url.pathname.split("/");
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (!ignoredSegments.has(segment)) {
      return segment;
    }
  }

  return "unknown";
}

function getScoreUrl() {
  const scoreId = encodeURIComponent(extractScoreIdFromUrl());
  return `https://hostb.anirudhasah.com/score/${scoreId}`;
}

function ensureOverlay() {
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
  }

  return { overlay, iframe };
}

function showOverlay() {
  const { overlay } = ensureOverlay();
  overlay.style.display = "block";
}

function hideOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.style.display = "none";
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "AD_STARTED") {
    showOverlay();
  }

  if (message?.type === "AD_ENDED") {
    hideOverlay();
  }
});

ensureOverlay();
