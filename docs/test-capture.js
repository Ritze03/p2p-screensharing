// TEST ONLY - loaded by app.js solely when the URL has ?testCapture=canvas (never in normal use).
// Replaces getDisplayMedia with a canvas stream so headless browsers can "share a screen":
//   ?testCapture=canvas[&testFps=240][&testW=1280&testH=720]
// The canvas is redrawn at testFps (default: the requested frame rate) by a MessageChannel loop,
// because requestAnimationFrame is capped to the display refresh rate.
export function canvasGetDisplayMedia(qs) {
  return async (constraints) => {
    const asked = Number(constraints?.video?.frameRate?.ideal ?? constraints?.video?.frameRate?.max) || 60;
    const hz = Number(qs.get('testFps')) || asked;
    const c = document.createElement('canvas');
    c.width = Number(qs.get('testW')) || 1280;
    c.height = Number(qs.get('testH')) || 720;
    const ctx = c.getContext('2d');
    const stream = c.captureStream();
    const track = stream.getVideoTracks()[0];
    let n = 0;
    let next = performance.now();
    const draw = () => {
      ctx.fillStyle = `hsl(${(n * 3) % 360} 60% 25%)`;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect((n * 7) % (c.width - 120), (n * 5) % (c.height - 120), 120, 120);
      ctx.fillStyle = '#000';
      ctx.font = '64px monospace';
      ctx.fillText(String(n), 40, 100);
      n++;
    };
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      if (track.readyState === 'ended') return;
      const now = performance.now();
      if (now >= next) {
        next = Math.max(next + 1000 / hz, now - 50);
        draw();
      }
      ch.port2.postMessage(0);
    };
    ch.port2.postMessage(0);
    return stream;
  };
}
