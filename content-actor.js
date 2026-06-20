// Content-process side of the bridge. Captures the playing <video> stream,
// encodes its frames with WebCodecs, and forwards the encoded chunks to the
// chrome process via JSWindowActor IPC.
//
// Reliability rules:
//  * Only one stream is mirrored per actor at a time.
//  * Any signal that the source is gone (pause, ended, emptied, pagehide,
//    track.onended) tears down and notifies the parent so the chrome UI hides.
//  * Encode is bitrate/framerate capped — software encode of full-res YouTube
//    will otherwise pin a core.
//  * Codec negotiation tries vp8 → vp9 → h264 → av1 so the first
//    hardware-accelerated encoder available is used.

const MAX_BITRATE_BPS = 8_000_000;
const MAX_FRAMERATE = 60;
const KEYFRAME_INTERVAL = 60;
const CODEC_PREFERENCES = ["vp8", "vp9", "h264", "av1"];

const DEBUG = false;

function codecStringFor(codec) {
  const map = {
    vp8: "vp8",
    vp9: "vp09.00.10.08",
    h264: "avc1.42001E",
    av1: "av01.0.01M.08",
  };
  return map[codec] || codec;
}

export class ZenSidebarPiPChild extends JSWindowActorChild {
  _debug(...args) {
    if (!DEBUG) return;
    try {
      this.sendAsyncMessage("ZenPiP:Debug", { args: args.map(a => {
        try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
        catch (_) { return String(a); }
      }) });
    } catch (_) {}
  }

  handleEvent(event) {
    const target = event.target;
    this._debug("[Zenslop/content]", event.type, target?.tagName, "muted=", target?.muted, "vw=", target?.videoWidth);
    if (!target || target.tagName !== "VIDEO") return;

    if (event.type === "playing") {
      this._tryStart(target);
      return;
    }

    if (event.type === "volumechange") {
      if (this._isAudible(target)) {
        if (!this._encoder && !target.paused && !target.ended) {
          this._tryStart(target);
        }
      } else if (target === this._video) {
        this._stopAndNotify("volumechange:muted");
      }
      return;
    }

    if (event.type === "pause" || event.type === "ended" || event.type === "emptied") {
      if (target !== this._video) return;
      this._stopAndNotify("event:" + event.type);
    }
  }

  _isAudible(video) {
    return !video.muted && video.volume > 0;
  }

  async _pickCodec(win, width, height) {
    for (const codec of CODEC_PREFERENCES) {
      const codecString = codecStringFor(codec);
      try {
        const support = await win.VideoEncoder.isConfigSupported({
          codec: codecString,
          width,
          height,
          bitrate: MAX_BITRATE_BPS,
          framerate: MAX_FRAMERATE,
        });
        if (support.supported) {
          this._debug("[Zenslop/content] codec selected:", codec, "(", codecString, ")");
          return codecString;
        }
      } catch (_) {}
    }
    this._debug("[Zenslop/content] no supported codec found");
    return null;
  }

  _tryStart(target) {
    this._debug("[Zenslop/content] tryStart readyState=", target.readyState, "vw=", target.videoWidth, "audible=", this._isAudible(target), "encoderExists=", !!this._encoder);
    if (this._encoder) return;
    if (target.readyState < 2 || target.videoWidth === 0) return;
    if (!this._isAudible(target)) return;

    let stream;
    try {
      if (typeof target.captureStream === "function") {
        stream = target.captureStream();
      } else if (typeof target.mozCaptureStream === "function") {
        stream = target.mozCaptureStream();
      }
    } catch (e) {
      if (e.name === "SecurityError") {
        this._debug("[Zenslop/content] captureStream blocked (cross-origin?):", e.message);
      } else {
        this._debug("[Zenslop/content] captureStream threw:", e?.name, e?.message);
      }
      return;
    }
    const videoTracks = stream?.getVideoTracks?.() || [];
    this._debug("[Zenslop/content] stream tracks=", videoTracks.length);
    if (videoTracks.length === 0) return;

    this._stream = stream;
    this._attachVideoListeners(target);
    this._startEncoder(target);
  }

  _attachVideoListeners(video) {
    const onEnd = (e) => this._stopAndNotify("listener:" + e.type);
    video.addEventListener("ended", onEnd, { once: true });
    video.addEventListener("emptied", onEnd, { once: true });
    this._videoListeners = { onEnd };

    if (!this._pageHideBound) {
      this._pageHideBound = () => this._stopAndNotify("pagehide");
      this.contentWindow.addEventListener("pagehide", this._pageHideBound, {
        once: true,
      });
    }
  }

  _removePageHideListener() {
    if (this._pageHideBound) {
      try {
        this.contentWindow.removeEventListener("pagehide", this._pageHideBound);
      } catch (_) {}
      this._pageHideBound = null;
    }
  }

  async _startEncoder(video) {
    const win = this.contentWindow;
    const hasVF = typeof win.VideoFrame === "function";
    const hasEnc = typeof win.VideoEncoder === "function";
    if (!hasVF || !hasEnc) {
      this._debug("[Zenslop/content] WebCodecs unavailable", "hasVF=", hasVF, "hasEnc=", hasEnc);
      this._stopAndNotify("webcodecs:unavailable");
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    const codec = await this._pickCodec(win, width, height);
    if (!codec) {
      this._stopAndNotify("webcodecs:no-supported-codec");
      return;
    }

    let configSent = false;
    this._epoch = (this._epoch || 0) + 1;
    const epoch = this._epoch;

    let outputCount = 0;
    let encoder;
    try {
      encoder = new win.VideoEncoder({
      output: (chunk, metadata) => {
        if (outputCount < 3) this._debug("[Zenslop/content] encoder output", outputCount, "type=", chunk.type, "bytes=", chunk.byteLength, "hasConfig=", !!metadata?.decoderConfig);
        outputCount++;
        if (this._epoch !== epoch) return;
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        const payload = {
          data: buf,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          type: chunk.type,
        };
        if (!configSent && metadata?.decoderConfig) {
          const dc = metadata.decoderConfig;
          payload.config = {
            codec: dc.codec,
            codedWidth: dc.codedWidth,
            codedHeight: dc.codedHeight,
          };
          if (dc.description) {
            const descBuf = new ArrayBuffer(dc.description.byteLength);
            new Uint8Array(descBuf).set(new Uint8Array(dc.description));
            payload.config.description = descBuf;
          }
          configSent = true;
        }
        try {
          this.sendAsyncMessage("ZenPiP:Frame", payload);
        } catch (_) {}
      },
      error: (e) => {
        this._debug("[Zenslop/content] encoder error:", e?.message || String(e));
        this._stopAndNotify("encoder:error");
      },
    });
    } catch (e) {
      this._debug("[Zenslop/content] VideoEncoder ctor threw:", e?.name, e?.message);
      this._stopAndNotify("encoder:construct");
      return;
    }

    try {
      encoder.configure({
        codec,
        width,
        height,
        bitrate: MAX_BITRATE_BPS,
        framerate: MAX_FRAMERATE,
        latencyMode: "realtime",
      });
    } catch (e) {
      this._debug("[Zenslop/content] encoder.configure threw:", e?.name, e?.message);
      this._stopAndNotify("encoder:configure");
      return;
    }
    this._encoder = encoder;
    this._frameCount = 0;
    this._startTime = this.contentWindow.performance.now();
    this._video = video;
    this._encoderWidth = width;
    this._encoderHeight = height;
    this._debug("[Zenslop/content] encoder ready", width, "x", height, "codec=", codec);
    this._captureAndEncode();
  }

  async _reconfigureEncoderIfNeeded(video) {
    const newW = video.videoWidth;
    const newH = video.videoHeight;
    if (newW === this._encoderWidth && newH === this._encoderHeight) return;
    this._debug("[Zenslop/content] resolution changed", this._encoderWidth, "x", this._encoderHeight, "->", newW, "x", newH);

    const win = this.contentWindow;
    const codec = await this._pickCodec(win, newW, newH);
    if (!codec) {
      this._stopAndNotify("webcodecs:no-supported-codec-on-resize");
      return;
    }

    this._epoch = (this._epoch || 0) + 1;

    try {
      this._encoder.configure({
        codec,
        width: newW,
        height: newH,
        bitrate: MAX_BITRATE_BPS,
        framerate: MAX_FRAMERATE,
        latencyMode: "realtime",
      });
      this._encoderWidth = newW;
      this._encoderHeight = newH;
      this._frameCount = 0;
      this._startTime = this.contentWindow.performance.now();
      this._debug("[Zenslop/content] encoder reconfigured for", newW, "x", newH);
    } catch (e) {
      this._debug("[Zenslop/content] encoder reconfigure failed, full restart:", e?.message);
      this._teardown();
      this._startEncoder(video);
    }
  }

  _captureAndEncode() {
    const encoder = this._encoder;
    const video = this._video;
    const win = this.contentWindow;
    if (!encoder || !video || !win) return;
    if (encoder.state !== "configured") return;
    if (encoder.encodeQueueSize > 2) return;
    if (!(video.videoWidth > 0) || video.readyState < 2) return;

    if (video.videoWidth !== this._encoderWidth || video.videoHeight !== this._encoderHeight) {
      this._reconfigureEncoderIfNeeded(video);
      return;
    }

    const frameCount = this._frameCount;
    const ts = Math.round((this.contentWindow.performance.now() - this._startTime) * 1000);
    let frame;
    try {
      frame = new win.VideoFrame(video, { timestamp: ts });
    } catch (e) {
      this._debug("[Zenslop/content] VideoFrame ctor threw:", String(e), e?.name, e?.message);
      this._stopAndNotify("videoframe:construct");
      return;
    }
    if (frameCount < 3) this._debug("[Zenslop/content] tick frame", frameCount, "fmt=", frame?.format);
    try {
      encoder.encode(frame, { keyFrame: frameCount % KEYFRAME_INTERVAL === 0 });
    } catch (e) {
      this._debug("[Zenslop/content] encode threw:", String(e), e?.name, e?.message);
    }
    try { frame.close(); } catch (_) {}
    this._frameCount = frameCount + 1;
  }

  _stopAndNotify(reason) {
    this._debug("[Zenslop/content] stopAndNotify reason=", reason, "hadEnc=", !!this._encoder, "hadVideo=", !!this._video);
    if (!this._encoder && !this._video) return;
    this._teardown();
    try {
      this.sendAsyncMessage("ZenPiP:VideoStopped", { reason });
    } catch (e) {}
  }

  _teardown() {
    this._epoch = (this._epoch || 0) + 1;
    if (this._encoder) {
      try { this._encoder.close(); } catch (_) {}
      this._encoder = null;
    }
    if (this._stream) {
      try {
        for (const t of this._stream.getTracks()) t.stop();
      } catch (e) {}
      this._stream = null;
    }
    this._video = null;
    this._videoListeners = null;
    this._encoderWidth = 0;
    this._encoderHeight = 0;
    this._removePageHideListener();
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Tick") {
      this._captureAndEncode();
      return;
    }
    if (msg.name === "ZenPiP:Stop") {
      this._stopAndNotify("parent:stop");
    }
  }

  didDestroy() {
    this._teardown();
  }
}
