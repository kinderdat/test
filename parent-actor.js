// Chrome-process side. Receives encoded video chunks from the content actor,
// decodes them with WebCodecs, and paints the decoded VideoFrames directly
// onto the sidebar canvas via ZenPiPController.drawFrame().
//
// MediaStreamTrackGenerator isn't available in the chrome window in modern
// Firefox, so we render to a canvas instead of synthesizing a MediaStream.
//
// Frame extraction is driven by a chrome-process requestAnimationFrame loop
// that ticks the content actor at ~30 fps — rVFC on the content side is throttled
// to zero in background tabs, which would otherwise stall the mirror whenever
// the user navigates away from the source tab.

const TICK_INTERVAL_MS = 33; // ~30 fps

const DEBUG = false;

export class ZenSidebarPiPParent extends JSWindowActorParent {
  async receiveMessage(msg) {
    if (DEBUG) {
      const argsArr = Array.isArray(msg.data?.args) ? msg.data.args : null;
      if (argsArr) {
        console.log("[Zenslop/parent RX]", msg.name, JSON.stringify(argsArr));
      } else {
        console.log("[Zenslop/parent RX]", msg.name, JSON.stringify(msg.data));
      }
    }

    if (msg.name === "ZenPiP:Debug") {
      if (DEBUG) {
        const argsArr = Array.isArray(msg.data?.args) ? msg.data.args : null;
        if (argsArr && argsArr.length > 0) console.log(...argsArr);
      }
      return;
    }

    if (msg.name === "ZenPiP:SetDebug") {
      // Dynamic debug toggle — the content actor has its own static flag,
      // but we respect it here for the chrome side too.
      return;
    }

    const win = this.browsingContext?.topChromeWindow;
    if (!win) return;

    switch (msg.name) {
      case "ZenPiP:Frame": {
        if (!this._tickInterval) this._startTicking();
        if (DEBUG) {
          console.log("[Zenslop/parent] about to call _handleFrame, decoder=", !!this._decoder, "dataType=", typeof msg.data?.data, "dataIsAB=", msg.data?.data instanceof ArrayBuffer, "dataLen=", msg.data?.data?.byteLength);
        }
        try {
          await this._handleFrame(win, msg.data);
        } catch (e) {
          console.error("[Zenslop/parent] _handleFrame threw:", e?.name, e?.message || e);
        }
        break;
      }
      case "ZenPiP:VideoStopped": {
        this._handleStop();
        break;
      }
    }
  }

  _startTicking() {
    this._stopTicking();
    if (DEBUG) console.log("[Zenslop/parent] starting tick interval");
    this._tickInterval = true;
    const tick = () => {
      if (!this._tickInterval) return;
      const w = this.browsingContext?.topChromeWindow;
      if (!w) {
        this._stopTicking();
        return;
      }
      try {
        this.sendAsyncMessage("ZenPiP:Tick", {});
      } catch (_) {
        this._stopTicking();
        return;
      }
      this._tickRafId = w.requestAnimationFrame(tick);
    };
    const win = this.browsingContext?.topChromeWindow;
    if (win) {
      this._tickRafId = win.requestAnimationFrame(tick);
    }
  }

  _stopTicking() {
    this._tickInterval = false;
    if (this._tickRafId != null) {
      const win = this.browsingContext?.topChromeWindow;
      if (win) {
        try { win.cancelAnimationFrame(this._tickRafId); } catch (_) {}
      }
      this._tickRafId = null;
    }
  }

  async _handleFrame(win, payload) {
    if (!this._decoder) {
      if (DEBUG) {
        const dataByteLen = payload.data?.byteLength ?? -1;
        console.log("[Zenslop/parent] handleFrame first chunk, dataBytes=", dataByteLen, "type=", payload.type, "hasConfig=", !!payload.config);
      }
      if (!payload.config) return;
      const ok = await this._setupDecoder(win, payload.config);
      if (!ok) return;
    } else if (payload.config) {
      const changed = this._decoderConfig && (
        payload.config.codec !== this._decoderConfig.codec ||
        payload.config.codedWidth !== this._decoderConfig.codedWidth ||
        payload.config.codedHeight !== this._decoderConfig.codedHeight
      );
      if (changed) {
        if (DEBUG) console.log("[Zenslop/parent] config changed, reconfiguring decoder");
        this._resetDecoder();
        const ok = await this._setupDecoder(win, payload.config);
        if (!ok) return;
      }
    }

    let chunk;
    try {
      chunk = new win.EncodedVideoChunk({
        type: payload.type,
        timestamp: payload.timestamp,
        duration: payload.duration,
        data: payload.data,
      });
    } catch (e) {
      if (DEBUG) console.log("[Zenslop/parent] EncodedVideoChunk threw:", e?.message || e);
      return;
    }

    try {
      this._decoder.decode(chunk);
    } catch (e) {
      console.error("[Zenslop/parent] decode threw:", e?.message || e);
    }
  }

  _resetDecoder() {
    if (this._decoder) {
      try { this._decoder.close(); } catch (_) {}
      this._decoder = null;
      this._decoderConfig = null;
    }
  }

  async _setupDecoder(win, config) {
    if (typeof win.VideoDecoder !== "function") {
      console.error("[Zenslop/parent] VideoDecoder unavailable in chrome window");
      return false;
    }
    if (!win.ZenPiPController) {
      console.error("[Zenslop/parent] ZenPiPController missing on win");
      return false;
    }

    let supported = false;
    try {
      const result = await win.VideoDecoder.isConfigSupported({
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
        ...(config.description ? { description: config.description } : {}),
      });
      supported = result.supported;
      if (!supported) {
        console.error("[Zenslop/parent] VideoDecoder.isConfigSupported returned false for", config.codec, config.codedWidth, "x", config.codedHeight);
        return false;
      }
    } catch (e) {
      if (DEBUG) console.log("[Zenslop/parent] isConfigSupported check failed, trying anyway:", e?.message || e);
    }

    let decodedCount = 0;
    let decoder;
    try {
      decoder = new win.VideoDecoder({
        output: (frame) => {
          decodedCount++;
          if (DEBUG && (decodedCount <= 3 || decodedCount % 120 === 0)) {
            console.log("[Zenslop/parent] decoded frame", decodedCount, "ts=", frame.timestamp);
          }
          try {
            win.ZenPiPController.drawFrame(frame);
          } catch (e) {
            if (DEBUG) console.log("[Zenslop/parent] drawFrame threw:", e?.message || e);
          }
          try { frame.close(); } catch (_) {}
        },
        error: (e) => {
          console.error("[Zenslop/parent] decoder error:", e?.message || e);
          this._handleStop();
        },
      });
    } catch (e) {
      console.error("[Zenslop/parent] VideoDecoder ctor threw:", e?.name, e?.message || e);
      return false;
    }

    try {
      const cfg = {
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
      };
      if (config.description) cfg.description = config.description;
      decoder.configure(cfg);
    } catch (e) {
      console.error("[Zenslop/parent] decoder.configure threw:", e?.message || e);
      return false;
    }
    this._decoder = decoder;
    this._decoderConfig = { ...config };
    if (DEBUG) console.log("[Zenslop/parent] decoder configured", config.codedWidth, "x", config.codedHeight, "codec=", config.codec);

    try {
      win.ZenPiPController.showVideo(config.codedWidth, config.codedHeight, this.browsingContext);
    } catch (e) {
      console.error("[Zenslop/parent] showVideo threw:", e?.name, e?.message || e);
    }
    this._win = win;
    return true;
  }

  _handleStop() {
    this._stopTicking();
    this._resetDecoder();
    const win = this._win || this.browsingContext?.topChromeWindow;
    if (win && win.ZenPiPController) {
      win.ZenPiPController.hideVideo();
    }
    this._win = null;
  }

  didDestroy() {
    this._handleStop();
  }
}
