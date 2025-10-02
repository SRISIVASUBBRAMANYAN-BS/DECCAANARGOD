/*
  GRAPHITE SKETCH AR - Pure HTML/CSS/JS

  How to use:
  - Replace ./assets/gif1.gif, gif2.gif, gif3.gif with your GIFs.
  - Replace ./assets/music.mp3 with your MP3.
  - The target detection uses public/images/graphite-target.png (already added).
*/

const videoEl = document.getElementById("cam")
const overlayEl = document.getElementById("overlay")
const bellBtn = document.getElementById("bell")
const hintEl = document.getElementById("hint")
const musicEl = document.getElementById("music")

const gif1 = document.getElementById("gif1")
const gif2 = document.getElementById("gif2")
const gif3 = document.getElementById("gif3")
const gifFallback = document.getElementById("gifFallback")

const refImg = document.getElementById("refImg")
const procCanvas = document.getElementById("proc")
const tmplCanvas = document.getElementById("tmpl")
const procCtx = procCanvas.getContext("2d", { willReadFrequently: true })
const tmplCtx = tmplCanvas.getContext("2d", { willReadFrequently: true })

// Processing constants
const PROC_W = 192 // downscaled processing width
const FPS = 10 // processing framerate cap
const STEP = 4 // scan step in pixels
const LOCK_FRAMES = 6 // frames to confirm detection
const MSE_THRESHOLD = 2600 // lower -> stricter (tuned for downscaled frames)

// State
let playing = false
let detected = false
let stableCount = 0
let rafId = null
let lastBox = null // {x,y,w,h} in processing space
let stream = null

// Ensure GIF fallbacks if missing
;[gif1, gif2, gif3].forEach((img) => {
  img.addEventListener(
    "error",
    () => {
      img.classList.add("hidden")
      gifFallback.classList.remove("hidden")
    },
    { passive: true },
  )
})

musicEl.addEventListener(
  "error",
  () => {
    // fallback: generate a simple tone for 15 seconds if mp3 missing
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = "sine"
      o.frequency.value = 432 // gentle tone
      o.connect(g)
      g.connect(ctx.destination)
      g.gain.setValueAtTime(0.06, ctx.currentTime)
      o.start()
      setTimeout(() => {
        o.stop()
        ctx.close()
      }, 15000)
    } catch (e) {
      // no-op
    }
  },
  { passive: true },
)

init()

async function init() {
  await startCamera()
  await waitForRef()
  setupTemplate()
  startProcessing()
}

async function startCamera() {
  const constraintsList = [
    { video: { facingMode: { exact: "environment" } }, audio: false },
    { video: { facingMode: "environment" }, audio: false },
    { video: true, audio: false },
  ]
  for (const c of constraintsList) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c)
      videoEl.srcObject = stream
      await videoEl.play().catch(() => {})
      return
    } catch (e) {
      // try next
    }
  }
  alert("Unable to access camera.")
}

function waitForRef() {
  return new Promise((res) => {
    if (refImg.complete && refImg.naturalWidth > 0) return res()
    refImg.onload = () => res()
    refImg.onerror = () => res() // allow init even if not loaded (will reduce detection quality)
  })
}

function setupTemplate() {
  // Draw the reference image into a small template canvas
  // Target a square template to simplify sliding-window matching
  const size = 64
  tmplCanvas.width = size
  tmplCanvas.height = size

  const w = refImg.naturalWidth || 512
  const h = refImg.naturalHeight || 512
  const s = Math.min(w, h)
  tmplCtx.drawImage(refImg, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size)
}

function startProcessing() {
  const tickInterval = 1000 / FPS
  let last = 0

  const loop = (t) => {
    rafId = requestAnimationFrame(loop)
    if (t - last < tickInterval) return
    last = t

    if (!videoEl.videoWidth || !videoEl.videoHeight) return

    // Fit processing canvas to downscaled size with same aspect ratio
    const vw = videoEl.videoWidth
    const vh = videoEl.videoHeight
    const ratio = vw / vh
    const pw = PROC_W
    const ph = Math.round(pw / ratio)

    procCanvas.width = pw
    procCanvas.height = ph

    // Draw current frame into processing canvas
    procCtx.drawImage(videoEl, 0, 0, pw, ph)

    // Compute best match
    const match = findTemplate(procCtx, tmplCtx, STEP)

    if (match && match.score < MSE_THRESHOLD) {
      stableCount = Math.min(LOCK_FRAMES, stableCount + 1)
      lastBox = match.box
    } else {
      stableCount = Math.max(0, stableCount - 1)
    }

    detected = stableCount >= LOCK_FRAMES - 1

    // UI updates
    if (detected) {
      hintEl.textContent = "Target found! Tap the bell to start."
      bellBtn.classList.remove("hidden")
    } else {
      if (!playing) {
        hintEl.textContent = "Align the camera so the image fills the view"
        bellBtn.classList.add("hidden")
      }
    }

    // While playing, keep the overlay anchored/updated to the current or last known box
    if (playing && lastBox) {
      positionOverlay(lastBox, pw, ph)
    } else if (detected && lastBox) {
      // Pre-position overlay even before playing (for clarity)
      positionOverlay(lastBox, pw, ph)
    }
  }

  rafId = requestAnimationFrame(loop)
}

function findTemplate(frameCtx, tmplCtx, step = 4) {
  const fw = frameCtx.canvas.width
  const fh = frameCtx.canvas.height
  const tw = tmplCtx.canvas.width
  const th = tmplCtx.canvas.height

  const fData = frameCtx.getImageData(0, 0, fw, fh).data
  const tData = tmplCtx.getImageData(0, 0, tw, th).data

  // Precompute grayscale template and mean
  const tGray = new Uint8ClampedArray(tw * th)
  let tSum = 0
  for (let i = 0; i < tw * th; i++) {
    const r = tData[i * 4 + 0]
    const g = tData[i * 4 + 1]
    const b = tData[i * 4 + 2]
    const v = (r * 0.299 + g * 0.587 + b * 0.114) | 0
    tGray[i] = v
    tSum += v
  }
  const tMean = tSum / (tw * th)

  // Slide template
  let best = { x: 0, y: 0, score: Number.POSITIVE_INFINITY, box: null }
  for (let y = 0; y <= fh - th; y += step) {
    for (let x = 0; x <= fw - tw; x += step) {
      // Compute mean absolute error (fast, robust enough)
      let sum = 0
      let cnt = 0
      for (let ty = 0; ty < th; ty += 2) {
        // subsample for speed
        const fy = y + ty
        for (let tx = 0; tx < tw; tx += 2) {
          const fx = x + tx
          const fi = (fy * fw + fx) * 4
          const r = fData[fi + 0]
          const g = fData[fi + 1]
          const b = fData[fi + 2]
          const v = (r * 0.299 + g * 0.587 + b * 0.114) | 0
          const ti = ty * tw + tx
          const dv = v - tGray[ti]
          sum += Math.abs(dv)
          cnt++
        }
      }
      const mae = sum / cnt // lower is better

      if (mae < best.score) {
        best = {
          x,
          y,
          score: mae,
          box: { x, y, w: tw, h: th },
        }
      }
    }
  }

  return best
}

function positionOverlay(box, procW, procH) {
  // Map processing space (proc canvas) to video element displayed box
  const vw = videoEl.videoWidth
  const vh = videoEl.videoHeight

  // Video element client rect and object-fit: contain mapping
  const rect = videoEl.getBoundingClientRect()

  // Determine the rendered video size inside the element (contain)
  const elW = rect.width
  const elH = rect.height
  const srcRatio = vw / vh
  const elRatio = elW / elH

  let renderW, renderH, offsetX, offsetY
  if (srcRatio > elRatio) {
    // letterbox top/bottom
    renderW = elW
    renderH = elW / srcRatio
    offsetX = 0
    offsetY = (elH - renderH) / 2
  } else {
    // letterbox left/right
    renderH = elH
    renderW = elH * srcRatio
    offsetX = (elW - renderW) / 2
    offsetY = 0
  }

  // Scale factors from processing canvas to rendered video box
  const sx = renderW / procW
  const sy = renderH / procH

  const px = rect.left + offsetX + box.x * sx
  const py = rect.top + offsetY + box.y * sy
  const pw = box.w * sx
  const ph = box.h * sy

  overlayEl.style.transform = `translate(${px}px, ${py}px)`
  overlayEl.style.width = `${pw}px`
  overlayEl.style.height = `${ph}px`
}

bellBtn.addEventListener("click", async () => {
  if (!detected || playing) return
  playing = true
  bellBtn.classList.add("hidden")
  hintEl.textContent = "Playing sequence…"

  // Try to start audio; user gesture should allow it
  try {
    musicEl.currentTime = 0
    await musicEl.play()
  } catch (e) {
    // Autoplay might still fail in some browsers; it's OK
  }

  // 15s total: 3 segments of 5s each
  showOnly(gif1)
  const t1 = setTimeout(() => showOnly(gif2), 5000)
  const t2 = setTimeout(() => showOnly(gif3), 10000)

  // Stop after 15 seconds
  const tEnd = setTimeout(() => {
    endAR()
  }, 15000)

  // If the music ends first, still end at 15s to match requirement
  const onEnded = () => {
    // keep the 15s contract; do nothing here
  }
  musicEl.addEventListener("ended", onEnded, { once: true })

  // Keep references if needed (not used now)
  void t1
  void t2
  void tEnd
})

function showOnly(showEl) {
  ;[gif1, gif2, gif3].forEach((el) => el.classList.add("hidden"))
  gifFallback.classList.add("hidden")
  if (showEl) showEl.classList.remove("hidden")
}

function endAR() {
  playing = false
  // Hide overlays
  ;[gif1, gif2, gif3].forEach((el) => el.classList.add("hidden"))
  gifFallback.classList.add("hidden")
  hintEl.textContent = "AR finished. Align again to restart."
  // Music stop
  try {
    musicEl.pause()
  } catch {}
  // Let detection continue; bell will reappear when target is seen again
}

// Clean up on page unload
window.addEventListener("pagehide", () => {
  if (rafId) cancelAnimationFrame(rafId)
  if (stream) {
    stream.getTracks().forEach((t) => t.stop())
  }
})
