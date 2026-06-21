// Settings panel (gear in the Raspy header). Reads/writes the shared app_settings via /api/settings:
//   - voice routing mode (subscription = free claude -p on Mac/Pi; sdk = warm Agent SDK everywhere),
//   - per-device trailing-silence seconds (how long of a pause ends a voice command).
// Self-skips on the TV wall. Each control saves on change; no explicit save button.
if (!document.body.classList.contains('tv')) boot();

function boot() {
  const gear = document.getElementById('ai-gear');
  if (!gear) return;
  gear.addEventListener('click', open);
}

async function save(key, value) {
  try {
    await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: String(value) }),
    });
  } catch (_) {}
}

async function open() {
  let cur = {};
  try { cur = await (await fetch('/api/settings')).json(); } catch (_) {}
  const routing = cur.routing_mode === 'sdk' ? 'sdk' : 'subscription';
  const sil = (k, d) => { const n = parseFloat(cur[k]); return Number.isFinite(n) && n > 0 ? n : d; };

  const back = document.createElement('div');
  back.className = 'settings-back';
  back.innerHTML =
    '<div class="settings-panel" role="dialog" aria-modal="true">' +
      '<div class="settings-h"><h3>Settings</h3><button class="settings-x" type="button" aria-label="Close">✕</button></div>' +

      '<div class="settings-sec">Voice routing</div>' +
      '<div class="settings-seg" id="set-routing">' +
        '<button type="button" data-v="subscription"' + (routing === 'subscription' ? ' class="on"' : '') + '>Subscription</button>' +
        '<button type="button" data-v="sdk"' + (routing === 'sdk' ? ' class="on"' : '') + '>SDK</button>' +
      '</div>' +

      '<div class="settings-sec">Trailing silence (seconds)</div>' +
      row('Phone', 'phone_silence_s', sil('phone_silence_s', 3)) +
      row('ESP (Hey&nbsp;Rhasspy)', 'esp_silence_s', sil('esp_silence_s', 3)) +
      row('Mac', 'mac_silence_s', sil('mac_silence_s', 3)) +
    '</div>';
  document.body.appendChild(back);

  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelector('.settings-x').addEventListener('click', close);

  back.querySelector('#set-routing').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    back.querySelectorAll('#set-routing button').forEach((x) => x.classList.toggle('on', x === b));
    save('routing_mode', b.dataset.v);
  });
  back.querySelectorAll('.settings-num').forEach((inp) => {
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v) && v > 0) save(inp.dataset.key, v);
    });
  });
}

function row(label, key, val) {
  return '<label class="settings-row"><span>' + label + '</span>' +
    '<input class="settings-num" type="number" min="0.5" step="0.5" inputmode="decimal" data-key="' + key + '" value="' + val + '"></label>';
}
