# Air Draw Pro ✋

Draw in the air using hand gestures — no touch, no mouse, just your hands in front of the camera.

🔗 **Live Demo:** [air-draw-pro.netlify.app](https://air-draw-pro.netlify.app)

---

## Gestures

| Gesture | Action |
|---------|--------|
| ☝️ Index finger up | Draw on canvas |
| 🖐️ Open palm | Erase |
| ✊ Fist | Grab & move the artwork |

---

## Features
- **Two-hand support** — draw, erase, and move simultaneously with both hands
- **Artwork grab & move** — fist gesture pans the entire canvas
- **Sparkle effects** — particle trail follows drawing and erasing
- **Color picker** — 6 preset colors
- **Brush controls** — adjustable stroke thickness and glow intensity
- **Undo / Clear** — per-stroke undo, full canvas clear
- **Gesture stabilization** — frame debouncing prevents accidental mode switches
- **Live FPS counter** — real-time performance display

---

## Files

```
hand_recognition.html   # UI, layout, styles
hand_recognition.js     # All hand tracking & drawing logic
```

---

## Tech Stack

| Layer | Tool |
|-------|------|
| Hand tracking | [MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) |
| Rendering | HTML5 Canvas API (3 layered canvases) |
| UI | Vanilla JS · DM Sans font |
| Hosting | Netlify |

Zero dependencies. Zero build step.

---

## Run Locally

Open `hand_recognition.html` directly in any modern browser — no server needed.

> Camera permission required. Works best with good lighting and a plain background.

---

## Browser Support

Chrome, Edge, Firefox, Safari (iOS 15.4+). Requires HTTPS for camera access when hosted.
