# Zenslop

A [Sine](https://github.com/CosmoCreeper/Sine) mod for [Zen Browser](https://zen-browser.app/) that mirrors the currently playing video into the sidebar, anchored above the media controls.

<!-- HERO IMAGE — full-width screenshot of the sidebar with a video mirrored above the media controls -->
<p align="center">
  <img src="docs/hero.png" alt="Zenslop showing a video mirrored above the sidebar media controls" height="300">
</p>

---

## What it does

This mod hooks into the existing media playback controls and surfaces the video directly above it - so you can continue the doomscroll without dealing with adjusting the position of a separate PiP window or hiding the video altogether.

<!-- DEMO GIF — short loop of starting playback in a tab and the mirror appearing in the sidebar -->
<p align="center">
  <img src="docs/demo.gif" alt="Demo of starting playback in a tab and the PiP appearing in the sidebar" height="640">
</p>

---

## Installation

> [!NOTE]
> This mod is loaded through [Sine](https://github.com/CosmoCreeper/Sine), Zen's userscript loader. If you're loading user-chrome scripts via a different mechanism, just add this to your chrome folder like you would with other sine mods. 
> 
> Additionally, this mod requires installing Javascript to work, which is disabled by default for unofficial sources in Sine. If you would like to audit the project for malicious code, you can look at the source code in this repository.

1. Visit [about:settings](about:settings) and go to the "Sine Mods" section
2. Click the Settings icon to the right of the Install button, and turn on "Enable installing JS from unofficial sources. (unsafe, use at your own risk)" (see note above if hesitant)
3. Enter `Firebolt9907/Zenslop` into the text input box right under "or, add your own locally from a GitHub repo." and click Install
4. Restart your browser (important!!)

---

## Featured Forks

### Kawaiislop
**bboonstra/Kawaiislop/tree/bugfix**

<p align="center">
  <img src="docs/kawaiislop.png" alt="Picture of Zenslop" height="640">
</p>

### Contact me if you want to add your fork here

---

## The Technical Stuff

The mod runs in three pieces that bridge Firefox's e10s process boundary:

| File | Process | Responsibility |
| --- | --- | --- |
| `main.uc.js` | chrome | Injects the floating video container into the sidebar, registers the `JSWindowActor`, auto-detects the mod directory, and exposes `window.ZenPiPController`. |
| `content-actor.js` | content | Watches `playing` / `pause` / `volumechange` on `<video>` elements, captures the stream via `captureStream()`, encodes frames with WebCodecs `VideoEncoder`, and forwards encoded chunks over IPC to the parent. |
| `parent-actor.js` | chrome | Receives encoded video chunks via IPC, decodes them with WebCodecs `VideoDecoder`, and paints each `VideoFrame` onto the sidebar canvas via `ZenPiPController.drawFrame()`. Also drives frame capture by ticking the content actor at ~30 fps. |

### Why WebCodecs over IPC?

`captureStream()` produces a `MediaStream` bound to the content process. Chrome-process UI can't consume it directly. The original approach used a loopback `RTCPeerConnection`, but modern Firefox (post the WebRTC-out-of-parent-process refactor) doesn't gather ICE candidates for an `RTCPeerConnection` constructed in a chrome window, so the connection never converges.

Instead, we use WebCodecs:
- The **content actor** encodes each `VideoFrame` with `VideoEncoder` (trying vp8 → vp9 → h264 → av1 for best hardware support) and sends the resulting `EncodedVideoChunk` data as a transferable `ArrayBuffer` through the JSWindowActor IPC boundary.
- The **parent actor** receives each chunk, decodes it with `VideoDecoder`, and paints the `VideoFrame` directly to the sidebar canvas — zero-copy where the GPU allows it.

This avoids the ICE negotiation problem entirely, keeps latency minimal (no jitter buffer), and produces clean frames without the adaptive bitrate ramp-up that WebRTC suffers from.

Frame capture is driven by the chrome process: a `requestAnimationFrame` loop in the parent sends `ZenPiP:Tick` messages to the content actor. This is necessary because `requestVideoFrameCallback` in the content process is throttled to zero when the source tab is in the background.

---

## Usage

| Action | Result |
| --- | --- |
| Play a video in any tab | Mirror appears above the sidebar media controls. |
| Click the eye icon next to the PiP button | Toggle the mirror visibility without stopping playback. |
| Mute the source video | Mirror hides (mute is treated as the "this is an ad" signal). |
| Pause / close the source tab | Mirror animates out and the stream is released. |

<!-- TOGGLE SCREENSHOT — close-up of the media controls with the eye-toggle button highlighted -->
<p align="center">
  <img src="docs/toggle-button.png" alt="Eye-toggle button injected into the sidebar media controls" width="300">
</p>

---

## Configuration

Settings are available in the Sine Mods section of `about:settings` — look for the gear icon next to Zenslop.

| Setting | Default | Description |
| --- | --- | --- |
| Click to focus | On | Click the video preview to switch to the source tab |
| Glow effect | Off | Neon glow / shadow around the video preview |
| Glow color | `rgba(139, 92, 246, 0.4)` | CSS color for the glow (visible when glow is on) |
| Glow blur radius | 14 | Blur spread in px for the glow |
| Border radius | Zen default | Video preview corner style: Zen default / Sharp / Rounded / Pill / None |
| Max height | 600 | Maximum video preview height in px |
| Gap | 6 | Space between video and media controls in px |
| Tab list padding | On | Pad the tab list so tabs scroll above the video instead of behind it |
| Debug logging | Off | Verbose console logging for troubleshooting |

Internal tunables that don't have a UI (edit `main.uc.js` directly):

```js
const CONFIG = Object.freeze({
  ANIM_MS: 220,                 // entrance / exit animation duration
  ANIM_TAIL_MS: 350,            // keep ticking through animations after a state change
  ELEVATED_HOLD_MS: 180,        // hold elevated top through brief glitch frames
  DEFAULT_ASPECT: 16 / 9,
  PIP_OPEN_DEBOUNCE_MS: 1500,
  PIP_OBSERVE_TIMEOUT_MS: 3000,
});
```

Encoder caps live in `content-actor.js`:

```js
const MAX_BITRATE_BPS = 8_000_000;
const MAX_FRAMERATE = 60;
const KEYFRAME_INTERVAL = 60;
const CODEC_PREFERENCES = ["vp8", "vp9", "h264", "av1"];
```

A `DEBUG` flag (default `false`) exists in all three files — flip it to `true` for verbose console logging.

---

## Compatibility

- Built against **Zen Browser** (Firefox-based, ESR rapid channel).
- Uses `JSWindowActor`, `WebCodecs` (`VideoEncoder` / `VideoDecoder` / `VideoFrame`), `HTMLMediaElement.captureStream()`, and the Web Animations API. Older Firefox builds may silently fail if WebCodecs are unavailable.
- Tested with YT and YTM on macOS, but there shouldn't be anything OS-specific.

---

## Troubleshooting

<details>
<summary><strong>Nothing shows up in the sidebar.</strong></summary>

Open the Browser Toolbox (`Cmd+Opt+Shift+I` on macOS) and check the chrome-process console for `[Zenslop]` log lines (set `DEBUG = true` in `main.uc.js` first).

- `Could not find the music player UI.` — Zen has changed the selector for the media controls toolbar. Update `MUSIC_PLAYER_SELECTORS` in `main.uc.js`.
- `Could not auto-detect Zenslop mod folder` — the mod directory wasn't found inside `chrome/sine-mods/`. Make sure the folder name starts with `zenslop` (case-insensitive). Clones from GitHub are usually `Zenslop-main` which is auto-detected.
- `Failed to register JSWindowActor` — the `resource://` substitution didn't resolve. Check the above folder name issue.
</details>

<details>
<summary><strong>The mirror is offset / jumps when the controls expand.</strong></summary>

`ELEVATED_HOLD_MS` controls how long the mod holds the elevated top through brief glitch frames where Zen's expanded popup hasn't laid out yet. Bump it up if you see flicker.
</details>

<details>
<summary><strong>Video appears corrupted / wrong aspect ratio after quality change.</strong></summary>

The content actor now detects resolution changes and reconfigures the encoder. If the issue persists, check the console for `[Zenslop/content] resolution changed` messages and verify `VideoEncoder.isConfigSupported` returns true for the new resolution.
</details>

<details>
<summary><strong>Cross-origin videos don't mirror.</strong></summary>

`captureStream()` throws `SecurityError` on cross-origin videos without CORS headers. This is a browser security restriction and can't be worked around from a userscript.
</details>

---

## License

The MIT License (MIT)

Copyright (c) 2026 Rishu Sharma

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## Credits

- [Zen Browser](https://zen-browser.app/)
- [Sine](https://github.com/CosmoCreeper/Sine)
