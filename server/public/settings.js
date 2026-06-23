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
  const wrOn = !['0', 'false', 'off', 'no'].includes(String(cur.weight_reminder_enabled ?? '1').toLowerCase());
  const wrMode = cur.weight_reminder_mode === 'dynamic' ? 'dynamic' : 'manual';
  const wrTime = /^\d{2}:\d{2}$/.test(cur.weight_reminder_time || '') ? cur.weight_reminder_time : '08:00';
  const surplusVal = Number.isFinite(parseInt(cur.surplus_cal, 10)) ? parseInt(cur.surplus_cal, 10) : 150;

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

      '<div class="settings-sec">Weight reminder</div>' +
      '<div class="settings-seg" id="set-wr-enabled">' +
        '<button type="button" data-v="0"' + (wrOn ? '' : ' class="on"') + '>Off</button>' +
        '<button type="button" data-v="1"' + (wrOn ? ' class="on"' : '') + '>On</button>' +
      '</div>' +
      '<div class="settings-seg" id="set-wr-mode" style="margin-top:8px">' +
        '<button type="button" data-v="manual"' + (wrMode === 'manual' ? ' class="on"' : '') + '>Manual</button>' +
        '<button type="button" data-v="dynamic"' + (wrMode === 'dynamic' ? ' class="on"' : '') + '>Dynamic</button>' +
      '</div>' +
      '<label class="settings-row' + (wrMode === 'dynamic' ? ' dim' : '') + '" id="set-wr-time-row"><span>Time</span>' +
        '<input class="settings-time" type="time" id="set-wr-time" value="' + wrTime + '"' + (wrMode === 'dynamic' ? ' disabled' : '') + '></label>' +

      '<div class="settings-sec">Nutrition goal</div>' +
      '<label class="settings-row"><span>Surplus / deficit (kcal)<br><small>+ to bulk, − to cut, 0 = maintenance</small></span>' +
        '<input class="settings-num" type="number" step="10" min="-1000" max="1000" inputmode="numeric" id="set-surplus" value="' + surplusVal + '"></label>' +
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
      if (inp.dataset.key && Number.isFinite(v) && v > 0) save(inp.dataset.key, v);
    });
  });
  // Surplus/deficit: signed integer (negative = cut), so it bypasses the positive-only handler above.
  back.querySelector('#set-surplus').addEventListener('change', (e) => {
    let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) return;
    v = Math.max(-1000, Math.min(1000, v));   // clamp out typos (e.g. an accidental extra digit)
    e.target.value = v;
    save('surplus_cal', v);
  });

  back.querySelector('#set-wr-enabled').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    back.querySelectorAll('#set-wr-enabled button').forEach((x) => x.classList.toggle('on', x === b));
    save('weight_reminder_enabled', b.dataset.v);
  });
  const wrTimeRow = back.querySelector('#set-wr-time-row');
  const wrTimeInp = back.querySelector('#set-wr-time');
  back.querySelector('#set-wr-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    back.querySelectorAll('#set-wr-mode button').forEach((x) => x.classList.toggle('on', x === b));
    const dynamic = b.dataset.v === 'dynamic';
    wrTimeRow.classList.toggle('dim', dynamic);   // manual time is irrelevant in dynamic mode
    wrTimeInp.disabled = dynamic;
    save('weight_reminder_mode', b.dataset.v);
  });
  wrTimeInp.addEventListener('change', () => {
    if (/^\d{2}:\d{2}$/.test(wrTimeInp.value)) save('weight_reminder_time', wrTimeInp.value);
  });
}

function row(label, key, val) {
  return '<label class="settings-row"><span>' + label + '</span>' +
    '<input class="settings-num" type="number" min="0.5" step="0.5" inputmode="decimal" data-key="' + key + '" value="' + val + '"></label>';
}
