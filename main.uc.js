// ==UserScript==
// @name           Zenslop
// @version        1.2.0
// @description    Hooks into Zen's sidebar to render active video streams.
// ==/UserScript==

(function () {
  if (window.__zenslopLoaded) return;
  window.__zenslopLoaded = true;

  const PREF_BRANCH = "zenslop.";

  const Prefs = {
    getBool(key, fallback) {
      try { return Services.prefs.getBoolPref(PREF_BRANCH + key, fallback); }
      catch (_) { return fallback; }
    },
    getChar(key, fallback) {
      try { return Services.prefs.getCharPref(PREF_BRANCH + key, fallback); }
      catch (_) { return fallback; }
    },
    getInt(key, fallback) {
      try { return Services.prefs.getIntPref(PREF_BRANCH + key, fallback); }
      catch (_) { return fallback; }
    },
    observe(key, callback) {
      const observer = {
        observe(subject, topic, data) {
          if (topic === "nsPref:changed" && data === PREF_BRANCH + key) callback();
        },
      };
      try { Services.prefs.addObserver(PREF_BRANCH + key, observer, false); }
      catch (_) {}
      return observer;
    },
  };

  function readSettings() {
    return {
      clickToFocus: Prefs.getBool("clickToFocus", true),
      glowEffect: Prefs.getBool("glowEffect", false),
      glowColor: Prefs.getChar("glowColor", "rgba(139, 92, 246, 0.4)"),
      glowSize: Prefs.getChar("glowSize", "14"),
      borderRadius: Prefs.getChar("borderRadius", "default"),
      maxHeight: parseInt(Prefs.getChar("maxHeight", "600"), 10) || 600,
      gap: parseInt(Prefs.getChar("gap", "6"), 10) || 6,
      tabPadding: Prefs.getBool("tabPadding", true),
      debugLogging: Prefs.getBool("debugLogging", false),
    };
  }

  let S = readSettings();

  const LOG_PREFIX = "[Zenslop]";
  const log = (...a) => { if (S.debugLogging) console.log(LOG_PREFIX, ...a); };
  const warn = (...a) => { if (S.debugLogging) console.warn(LOG_PREFIX, ...a); };
  const err = (...a) => console.error(LOG_PREFIX, ...a);
  const safe = (fn) => {
    try { return fn(); }
    catch (_) { return undefined; }
  };

  const CONFIG = Object.freeze({
    ANIM_MS: 220,
    ANIM_TAIL_MS: 350,
    ELEVATED_HOLD_MS: 180,
    DEFAULT_ASPECT: 16 / 9,
    PIP_OPEN_DEBOUNCE_MS: 1500,
    PIP_OBSERVE_TIMEOUT_MS: 3000,
  });

  const MUSIC_PLAYER_SELECTORS =
    "#zen-media-controls-toolbar, .zen-sidebar-bottom-buttons";
  const PIP_BUTTON_SELECTORS = [
    '[id*="pictureinpicture" i]',
    '[class*="pictureinpicture" i]',
    '[command*="pictureinpicture" i]',
    '[id*="pip" i]',
    '[class*="pip" i]',
    '[anonid*="pictureinpicture" i]',
  ].join(",");

  const musicPlayerUI = document.querySelector(MUSIC_PLAYER_SELECTORS);
  if (!musicPlayerUI) {
    err("Could not find the music player UI.");
    return;
  }

  function applyVisualStyles() {
    const br = S.borderRadius === "default"
      ? "var(--zen-border-radius)"
      : S.borderRadius + "px";
    pipContainer.style.borderRadius = br;

    if (S.glowEffect) {
      const size = parseInt(S.glowSize, 10) || 14;
      pipContainer.style.boxShadow = `0 0 ${size}px ${S.glowColor}, 0 0 ${size * 2}px ${S.glowColor}`;
    } else {
      pipContainer.style.boxShadow = "none";
    }

    pipContainer.style.pointerEvents = S.clickToFocus ? "auto" : "none";
    pipContainer.style.cursor = S.clickToFocus ? "pointer" : "default";
  }

  const styleEl = document.createElement("style");
  styleEl.textContent = `
    #zen-sidebar-pip-container {
      position: fixed;
      background: transparent;
      display: none;
      border-radius: var(--zen-border-radius);
      overflow: hidden;
      contain: size layout;
      z-index: 10;
      pointer-events: none;
      transform-origin: 50% 100%;
      will-change: opacity, transform;
    }
    #zen-sidebar-pip-container > canvas {
      width: 100%;
      height: 100%;
      max-width: 100%;
      max-height: 100%;
      min-width: 0;
      min-height: 0;
      object-fit: contain;
      display: block;
    }
    #zen-sidebar-pip-toggle {
      flex: 0 0 auto;
    }
  `;
  document.documentElement.appendChild(styleEl);

  const pipContainer = document.createElement("div");
  pipContainer.id = "zen-sidebar-pip-container";
  const canvasEl = document.createElement("canvas");
  const canvasCtx = canvasEl.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });
  pipContainer.appendChild(canvasEl);
  document.documentElement.appendChild(pipContainer);

  applyVisualStyles();

  let lastTop = -1, lastLeft = -1, lastWidth = -1;
  let lastVisible = null;
  let lastOpacity = NaN;
  let isStreaming = false;
  let userHidden = false;
  let scheduled = false;
  let activeUntil = 0;
  let hoverActive = false;
  let lastElevatedTop = null;
  let lastElevatedAt = 0;
  let currentAnimation = null;
  let animateOutTimer = null;
  let videoAspect = CONFIG.DEFAULT_ASPECT;

  const observers = [];
  const prefObservers = [];
  const eventListeners = [];

  function addEventListener(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    eventListeners.push({ target, type, handler, options });
  }

  function setSourceDimensions(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    if (canvasEl.width !== w) canvasEl.width = w;
    if (canvasEl.height !== h) canvasEl.height = h;
    const nextAspect = w / h;
    if (nextAspect !== videoAspect) {
      videoAspect = nextAspect;
      lastTop = lastLeft = lastWidth = -1;
      bump();
    }
  }

  let lastTabPad = -1;
  let paddedTab = null;
  function findBottomMostTab() {
    const tabs = document.querySelectorAll(".tabbrowser-tab");
    let best = null, bestBottom = -Infinity;
    for (const t of tabs) {
      if (t.hidden) continue;
      const r = t.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom > bestBottom) { bestBottom = r.bottom; best = t; }
    }
    return best;
  }
  function clearPaddedTab() {
    if (paddedTab && paddedTab.isConnected) paddedTab.style.marginBottom = "";
    paddedTab = null;
  }
  function setTabListPadding(px) {
    if (!S.tabPadding) { clearPaddedTab(); lastTabPad = -1; return; }
    const target = px > 0 ? findBottomMostTab() : null;
    if (px === lastTabPad && target === paddedTab) return;
    lastTabPad = px;

    const value = px > 0 ? px + "px" : "";
    const scrollbox = document.querySelector("#tabbrowser-arrowscrollbox");
    if (scrollbox) scrollbox.style.paddingBottom = value;

    if (target !== paddedTab) clearPaddedTab();
    if (target) {
      target.style.marginBottom = value;
      paddedTab = target;
    }
  }

  function getMediaTopEdge(walkDescendants) {
    const baseRect = musicPlayerUI.getBoundingClientRect();
    let top = baseRect.top;
    if (walkDescendants) {
      const kids = musicPlayerUI.querySelectorAll("*");
      for (let i = 0; i < kids.length; i++) {
        const r = kids[i].getBoundingClientRect();
        if (r.width !== 0 && r.height !== 0 && r.top < top) top = r.top;
      }
    }
    return { top, baseTop: baseRect.top, left: baseRect.left, width: baseRect.width };
  }

  function getMediaPlayerVisibility() {
    if (musicPlayerUI.hidden || musicPlayerUI.hasAttribute("hidden"))
      return { visible: false, opacity: 0 };
    const cs = window.getComputedStyle(musicPlayerUI);
    if (cs.display === "none" || cs.visibility === "hidden")
      return { visible: false, opacity: 0 };
    if (musicPlayerUI.offsetParent === null && cs.position !== "fixed")
      return { visible: false, opacity: 0 };
    const r = musicPlayerUI.getBoundingClientRect();
    if (r.width === 0 || r.height === 0)
      return { visible: false, opacity: 0 };
    return { visible: true, opacity: parseFloat(cs.opacity) };
  }

  function syncPosition() {
    scheduled = false;
    if (!isStreaming) return;

    const { visible, opacity } = getMediaPlayerVisibility();
    const effectivelyVisible = visible && !userHidden;
    if (effectivelyVisible !== lastVisible) {
      pipContainer.style.visibility = effectivelyVisible ? "visible" : "hidden";
      lastVisible = effectivelyVisible;
    }
    if (!currentAnimation) {
      const op = userHidden ? 0 : opacity;
      if (op !== lastOpacity) {
        pipContainer.style.opacity = String(op);
        lastOpacity = op;
      }
    }

    if (effectivelyVisible) {
      const { top: mediaTopRaw, baseTop, left, width: playerWidth } = getMediaTopEdge(true);
      if (playerWidth !== 0) {
        let width = playerWidth;
        let height = width / videoAspect;
        if (height > S.maxHeight) {
          height = S.maxHeight;
          width = height * videoAspect;
        }
        const adjustedLeft = left + (playerWidth - width) / 2;

        const now = performance.now();
        let mediaTop = mediaTopRaw;
        if (mediaTopRaw < baseTop - 1) {
          lastElevatedTop = mediaTopRaw;
          lastElevatedAt = now;
        } else if (lastElevatedTop !== null && now - lastElevatedAt < CONFIG.ELEVATED_HOLD_MS) {
          mediaTop = lastElevatedTop;
          schedule();
        } else {
          lastElevatedTop = null;
        }

        const top = mediaTop - S.gap - height;
        if (top !== lastTop || adjustedLeft !== lastLeft || width !== lastWidth) {
          const s = pipContainer.style;
          s.width = width + "px";
          s.height = height + "px";
          s.left = adjustedLeft + "px";
          s.top = top + "px";
          lastTop = top;
          lastLeft = adjustedLeft;
          lastWidth = width;
          activeUntil = now + CONFIG.ANIM_TAIL_MS;
        }
        setTabListPadding(userHidden ? 0 : Math.ceil(height + S.gap * 2));
      }
    } else {
      setTabListPadding(0);
    }

    if (hoverActive || performance.now() < activeUntil) schedule();
  }

  function schedule() {
    if (scheduled || !isStreaming) return;
    scheduled = true;
    requestAnimationFrame(syncPosition);
  }

  function bump() {
    activeUntil = performance.now() + CONFIG.ANIM_TAIL_MS;
    schedule();
  }

  function startTracking() {
    lastTop = lastLeft = lastWidth = -1;
    lastVisible = null;
    lastOpacity = NaN;
    bump();
  }
  function stopTracking() {
    activeUntil = 0;
    hoverActive = false;
    lastElevatedTop = null;
    lastElevatedAt = 0;
    setTabListPadding(0);
  }

  function cancelAnimation() {
    if (currentAnimation) { currentAnimation.cancel(); currentAnimation = null; }
    if (animateOutTimer) { clearTimeout(animateOutTimer); animateOutTimer = null; }
  }

  addEventListener(musicPlayerUI, "mouseenter", () => { hoverActive = true; bump(); });
  addEventListener(musicPlayerUI, "mouseleave", () => { hoverActive = false; bump(); });
  for (const ev of ["transitionrun", "transitionend", "animationstart", "animationend"]) {
    addEventListener(musicPlayerUI, ev, bump);
  }

  let resizeObserver = null;
  safe(() => {
    resizeObserver = new ResizeObserver(bump);
    resizeObserver.observe(musicPlayerUI);
    resizeObserver.observe(document.documentElement);
  });

  addEventListener(window, "resize", bump);

  const EYE_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='context-fill' fill-opacity='context-fill-opacity'>" +
    "<path d='M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z'/></svg>";
  const EYE_OFF_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='context-fill' fill-opacity='context-fill-opacity'>" +
    "<path d='M2 2l20 20-1.4 1.4-3.5-3.5A12 12 0 0 1 12 21C5 21 1 14 1 14a20 20 0 0 1 4.6-5.6L.6 3.4 2 2zm10 6a4 4 0 0 1 4 4c0 .6-.1 1.1-.3 1.6l-5.3-5.3c.5-.2 1-.3 1.6-.3zM12 5c7 0 11 7 11 7a20 20 0 0 1-3.7 4.6l-2.1-2.1A8 8 0 0 0 12 7c-.7 0-1.4.1-2 .3L7.7 5C9 4.4 10.4 5 12 5z'/></svg>";
  const eyeUrl = (svg) => `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  const EYE_URL = eyeUrl(EYE_SVG);
  const EYE_OFF_URL = eyeUrl(EYE_OFF_SVG);
  const STRIPPED_ATTRS = [
    "command", "oncommand", "onclick", "data-l10n-id",
    "style", "hidden", "collapsed", "disabled", "aria-hidden",
  ];

  let toggleBtn = null;
  let nativePipBtn = null;
  let _placing = false;

  function parkNativePipButton(btn) {
    if (!btn || btn === toggleBtn) return;
    nativePipBtn = btn;
    btn.style.display = "none";
    btn.setAttribute("aria-hidden", "true");
  }

  function buildToggle(template) {
    const btn = template.cloneNode(true);
    btn.id = "zen-sidebar-pip-toggle";
    btn.setAttribute("tooltiptext", "Toggle sidebar PiP");
    for (const a of STRIPPED_ATTRS) btn.removeAttribute(a);
    btn.style.listStyleImage = EYE_URL;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      userHidden = !userHidden;
      btn.style.listStyleImage = userHidden ? EYE_OFF_URL : EYE_URL;
      bump();
    });
    toggleBtn = btn;
    return btn;
  }

  function findExistingPipButton() {
    const candidates = musicPlayerUI.querySelectorAll(PIP_BUTTON_SELECTORS);
    for (const c of candidates) if (c !== toggleBtn) return c;
    return null;
  }

  function placeToggle() {
    if (_placing) return !!toggleBtn?.isConnected;
    _placing = true;
    try {
      if (toggleBtn && toggleBtn.isConnected) {
        parkNativePipButton(nativePipBtn);
        return true;
      }
      const existing = findExistingPipButton();
      if (existing && existing.parentNode) {
        const parent = existing.parentNode;
        const btn = buildToggle(existing);
        parent.insertBefore(btn, existing.nextSibling);
        parent.style.minWidth = "fit-content";
        parent.style.overflow = "visible";
        return true;
      }
      return false;
    } finally {
      _placing = false;
    }
  }

  const mainObserver = new MutationObserver(() => { bump(); placeToggle(); });
  mainObserver.observe(musicPlayerUI, {
    attributes: true,
    attributeFilter: ["hidden", "style", "class", "open", "collapsed"],
    childList: true,
    subtree: true,
  });
  observers.push(mainObserver);

  let sourceBC = null;
  let lastPipOpenAt = 0;

  function isBrowsingContextLive(bc) {
    if (!bc) return false;
    try { return bc.currentWindowGlobal != null; }
    catch (_) { return false; }
  }

  function getActiveActor() {
    if (!sourceBC || !isBrowsingContextLive(sourceBC)) { sourceBC = null; return null; }
    return safe(() => sourceBC.currentWindowGlobal?.getActor("ZenSidebarPiP")) || null;
  }

  function focusSourceTab() {
    if (!sourceBC) return;
    try {
      const browserEl = sourceBC.top?.embedderElement;
      if (!browserEl) return;
      const gb = window.gBrowser;
      if (!gb) return;
      const tab = gb.getTabForBrowser(browserEl);
      if (tab) gb.selectedTab = tab;
    } catch (_) {}
  }

  addEventListener(pipContainer, "click", (e) => {
    if (!S.clickToFocus) return;
    e.preventDefault();
    e.stopPropagation();
    focusSourceTab();
  });

  function awaitNextPipWindow() {
    let timeoutId = null;
    const unregister = () => safe(() => Services.ww.unregisterNotification(observer));
    const observer = {
      observe(subject, topic) {
        if (topic !== "domwindowopened") return;
        subject.addEventListener("load", () => {
          const wt = subject.document?.documentElement?.getAttribute("windowtype");
          if (wt !== "Toolkit:PictureInPicture") return;
          unregister();
          if (timeoutId) clearTimeout(timeoutId);
        }, { once: true });
      },
    };
    Services.ww.registerNotification(observer);
    timeoutId = setTimeout(unregister, CONFIG.PIP_OBSERVE_TIMEOUT_MS);
  }

  addEventListener(window, "deactivate", () => {
    if (!isStreaming) return;
    if (performance.now() - lastPipOpenAt < CONFIG.PIP_OPEN_DEBOUNCE_MS) return;
    if (!getActiveActor()) return;
    awaitNextPipWindow();
    lastPipOpenAt = performance.now();
  });

  window.ZenPiPController = {
    drawFrame(frame) {
      try { canvasCtx.drawImage(frame, 0, 0, canvasEl.width, canvasEl.height); }
      catch (_) {}
    },
    showVideo(width, height, browsingContext) {
      setSourceDimensions(width, height);
      const previousSourceBC = sourceBC;
      const nextSourceBC = browsingContext || null;
      if (nextSourceBC && !isBrowsingContextLive(nextSourceBC)) {
        err("showVideo: browsingContext is no longer live, ignoring");
        return;
      }
      const sourceChanged = previousSourceBC && nextSourceBC && previousSourceBC !== nextSourceBC;
      sourceBC = nextSourceBC;

      cancelAnimation();

      const wasStreaming = isStreaming;
      isStreaming = true;
      startTracking();

      if (wasStreaming && !sourceChanged) {
        const s = pipContainer.style;
        s.opacity = userHidden ? "0" : "1";
        s.visibility = userHidden ? "hidden" : "visible";
        s.transform = "";
        return;
      }

      const s = pipContainer.style;
      s.display = "block";
      s.visibility = userHidden ? "hidden" : "visible";

      s.transition = "none";
      s.opacity = "0";
      s.transform = "scale(0.9) translateY(8px)";
      void pipContainer.getBoundingClientRect();

      currentAnimation = pipContainer.animate(
        [
          { opacity: 0, transform: "scale(0.9) translateY(8px)" },
          { opacity: userHidden ? 0 : 1, transform: "scale(1) translateY(0)" },
        ],
        { duration: CONFIG.ANIM_MS, easing: "ease", fill: "forwards" },
      );
      currentAnimation.onfinish = () => {
        currentAnimation = null;
        s.opacity = String(userHidden ? 0 : 1);
        s.transform = "scale(1) translateY(0)";
        s.transition = "";
        lastOpacity = NaN;
      };
    },

    hideVideo() {
      if (!isStreaming && !currentAnimation && !animateOutTimer) return;
      cancelAnimation();

      const s = pipContainer.style;
      s.transition = "none";
      s.opacity = userHidden ? "0" : "1";
      s.transform = "scale(1) translateY(0)";
      void pipContainer.getBoundingClientRect();

      currentAnimation = pipContainer.animate(
        [
          { opacity: userHidden ? 0 : 1, transform: "scale(1) translateY(0)" },
          { opacity: 0, transform: "scale(0.9) translateY(8px)" },
        ],
        { duration: CONFIG.ANIM_MS, easing: "ease", fill: "forwards" },
      );
      currentAnimation.onfinish = () => {
        currentAnimation = null;
        safe(() => canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height));
        sourceBC = null;
        s.display = "none";
        s.transition = "none";
        s.transform = "";
        s.opacity = "";
        isStreaming = false;
        stopTracking();
        lastOpacity = NaN;
        lastVisible = null;
      };
    },

    setDebug(val) {},
  };

  // Preference change handlers
  function onPrefsChanged() {
    S = readSettings();
    applyVisualStyles();
    if (!S.tabPadding && isStreaming) setTabListPadding(0);
    if (isStreaming) bump();
  }

  for (const key of ["clickToFocus", "glowEffect", "glowColor", "glowSize", "borderRadius", "maxHeight", "gap", "tabPadding", "debugLogging"]) {
    prefObservers.push(Prefs.observe(key, onPrefsChanged));
  }

  // Auto-detect the mod directory
  function findModDir() {
    const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const sineModsDir = profileDir.clone();
    sineModsDir.append("chrome");
    sineModsDir.append("sine-mods");

    if (!sineModsDir.exists() || !sineModsDir.isDirectory()) {
      err("sine-mods directory not found at", sineModsDir.path);
      return null;
    }

    const entries = sineModsDir.directoryEntries;
    const modNameLower = "zenslop";
    let match = null;
    while (entries.hasMoreElements()) {
      const entry = entries.getNext().QueryInterface(Ci.nsIFile);
      if (!entry.isDirectory()) continue;
      const nameLower = entry.leafName.toLowerCase();
      if (nameLower === modNameLower || nameLower.startsWith(modNameLower + "-") || nameLower.startsWith(modNameLower + "_")) {
        if (!match || entry.leafName.length < match.leafName.length) match = entry;
      }
    }

    if (!match) err("Could not auto-detect Zenslop mod folder in", sineModsDir.path);
    return match;
  }

  try {
    const modDir = findModDir();
    if (modDir) {
      const modUri = Services.io.newFileURI(modDir);
      const resProto = Services.io
        .getProtocolHandler("resource")
        .QueryInterface(Ci.nsIResProtocolHandler);
      if (!resProto.hasSubstitution("zen-sidebar-pip")) {
        resProto.setSubstitution("zen-sidebar-pip", modUri);
      }
      log("resource mapped to:", modUri.spec, "exists:", modDir.exists());

      ChromeUtils.registerWindowActor("ZenSidebarPiP", {
        parent: { esModuleURI: "resource://zen-sidebar-pip/parent-actor.js" },
        child: {
          esModuleURI: "resource://zen-sidebar-pip/content-actor.js",
          events: {
            playing: { capture: true, mozSystemGroup: true },
            pause: { capture: true, mozSystemGroup: true },
            volumechange: { capture: true, mozSystemGroup: true },
          },
        },
        messageManagerGroups: ["browsers"],
        allFrames: true,
      });
    }
  } catch (e) {
    if (e.name !== "NotSupportedError") err("Failed to register JSWindowActor:", e);
  }

  addEventListener(window, "unload", () => {
    cancelAnimation();
    stopTracking();

    for (const obs of observers) obs.disconnect();
    observers.length = 0;

    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }

    for (const obs of prefObservers) {
      try { Services.prefs.removeObserver(PREF_BRANCH, obs); } catch (_) {}
    }
    prefObservers.length = 0;

    for (const { target, type, handler, options } of eventListeners) {
      try { target.removeEventListener(type, handler, options); } catch (_) {}
    }
    eventListeners.length = 0;

    if (toggleBtn && toggleBtn.isConnected) toggleBtn.remove();
    clearPaddedTab();
    if (styleEl.isConnected) styleEl.remove();
    if (pipContainer.isConnected) pipContainer.remove();

    delete window.ZenPiPController;
    delete window.__zenslopLoaded;

    try {
      const resProto = Services.io
        .getProtocolHandler("resource")
        .QueryInterface(Ci.nsIResProtocolHandler);
      if (resProto.hasSubstitution("zen-sidebar-pip")) {
        resProto.setSubstitution("zen-sidebar-pip", null);
      }
    } catch (_) {}

    try { ChromeUtils.unregisterWindowActor("ZenSidebarPiP"); } catch (_) {}
  });

  log("Zenslop initialized.");
})();
