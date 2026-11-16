// Live values from the local Python process and macOS; no simulated activity.
export function mountRuntimeMonitor() {
  const byId = id => document.getElementById(id);
  const toggle = byId('runtime-toggle'), panel = byId('runtime-proof');
  const scene = byId('trick-scene'), samples = [];
  let generation = 0, timer, controller;
  const text = (id, value) => { byId(id).textContent = value; };
  const memory = bytes => bytes == null ? '—' : `${(bytes / 1048576).toFixed(0)} MiB`;

  async function poll(current) {
    if (current !== generation || panel.hidden) return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch('/api/runtime', {signal:controller.signal, cache:'no-store'});
      if (!response.ok) throw new Error('Runtime unavailable');
      const data = await response.json();
      if (current !== generation || panel.hidden) return;
      const model = data.model, gpu = data.gpu, last = model?.last_execution;
      text('runtime-chip', gpu?.name || (model?.model_device?.startsWith('mps') ? 'Apple GPU' : 'Local CPU'));
      text('runtime-process', `${data.process} · PID ${data.pid}`);
      text('runtime-origin', location.origin);
      text('runtime-model', model?.model_device || 'Loading');
      text('runtime-memory', memory(model?.tensor_bytes));
      text('runtime-metal', last?.metal_ms == null ? '—' : `${last.metal_ms.toFixed(1)} ms`);
      text('runtime-tensors', last ? `${last.input_device} → ${last.embedding_device}` : 'Waiting for a clip');
      text('runtime-state', `${data.busy ? 'Analyzing' : 'Ready'} · ${model?.completed || 0} clips completed`);
      text('runtime-offline', data.model_offline ? 'Encoder runs offline' : 'Local process');
      panel.dataset.busy = String(data.busy);
      const utilization = gpu?.utilization_percent;
      text('runtime-percent', utilization == null ? 'Unavailable' : `${utilization}%`);
      if (utilization != null) {
        if (samples.at(-1)?.at !== gpu.sampled_at) samples.push({at:gpu.sampled_at,value:utilization});
        while (samples.length > 60) samples.shift();
        const first = samples[0].at, elapsed = Math.max(30, gpu.sampled_at - first);
        const points = samples.map(s => `${300 - (gpu.sampled_at - s.at) / elapsed * 300},${40 - s.value * .38}`).join(' ');
        byId('runtime-line').setAttribute('points', points);
      } else {
        samples.length = 0;
        byId('runtime-line').setAttribute('points', '');
      }
      text('runtime-updated', `Live · ${new Date(data.sampled_at * 1000).toLocaleTimeString()}`);
    } catch (error) {
      if (current === generation && !panel.hidden) {
        text('runtime-state', error.name === 'AbortError' ? 'Reading timed out' : 'Local monitor unavailable');
        text('runtime-updated', 'Disconnected');
      }
    } finally {
      clearTimeout(timeout);
      if (current === generation && !panel.hidden) timer = setTimeout(() => poll(current), 500);
    }
  }

  toggle.addEventListener('click', () => {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    panel.hidden = !panel.hidden;
    scene.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    toggle.textContent = panel.hidden ? 'Device activity ↗' : 'Hide device activity ↙';
    if (!panel.hidden) poll(generation);
  });
}
