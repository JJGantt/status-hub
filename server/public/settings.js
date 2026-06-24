// Settings panel (gear in the Raspy header). Reads/writes the shared app_settings via /api/settings:
//   - chat-box route (which of the two routes the TYPED box uses: efficiency=fast/Haiku/API,
//     accuracy=power/Opus+thinking). The two FAB buttons + wake words carry their own tier and ignore this.
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
  const route = ['fast', 'power', 'custom'].includes(cur.chatbox_route) ? cur.chatbox_route : 'power';
  const sil = (k, d) => { const n = parseFloat(cur[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  const wrOn = !['0', 'false', 'off', 'no'].includes(String(cur.weight_reminder_enabled ?? '1').toLowerCase());
  const wrMode = cur.weight_reminder_mode === 'dynamic' ? 'dynamic' : 'manual';
  const wrTime = /^\d{2}:\d{2}$/.test(cur.weight_reminder_time || '') ? cur.weight_reminder_time : '08:00';
  const surplusVal = Number.isFinite(parseInt(cur.surplus_cal, 10)) ? parseInt(cur.surplus_cal, 10) : 150;
  const wfOn = ['1', 'true', 'on', 'yes'].includes(String(cur.wakefree_enabled ?? '0').toLowerCase());
  const wfRoute = ['fast', 'power', 'custom'].includes(cur.wakefree_route) ? cur.wakefree_route : 'fast';
  const cMod = ['haiku', 'sonnet', 'opus'].includes(cur.custom_model) ? cur.custom_model : 'sonnet';
  const cThink = ['none', 'low', 'high'].includes(cur.custom_think) ? cur.custom_think : 'low';
  const cRun = cur.custom_runner === 'api' ? 'api' : 'local';
  const agentOn = ['1', 'true', 'on', 'yes'].includes(String(cur.agent_mode ?? '0').toLowerCase());
  const agentCwd = (cur.agent_cwd || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const resetMin = (() => { const s = parseFloat(cur.session_reset_s); return Number.isFinite(s) && s > 0 ? Math.round(s / 60) : 5; })();
  const wfThresh = sil('voiceid_threshold', 0.30);
  const wfPause = sil('wakefree_pause_s', 2);

  const back = document.createElement('div');
  back.className = 'settings-back';
  back.innerHTML =
    '<div class="settings-panel" role="dialog" aria-modal="true">' +
      '<div class="settings-h"><h3>Settings</h3><button class="settings-x" type="button" aria-label="Close">✕</button></div>' +

      '<div class="settings-sec">Chat box route</div>' +
      '<div class="settings-seg" id="set-routing">' +
        '<button type="button" data-v="fast"' + (route === 'fast' ? ' class="on"' : '') + '>Efficiency</button>' +
        '<button type="button" data-v="power"' + (route === 'power' ? ' class="on"' : '') + '>Accuracy</button>' +
        '<button type="button" data-v="custom"' + (route === 'custom' ? ' class="on"' : '') + '>Custom</button>' +
      '</div>' +

      '<div class="settings-sec">Custom route</div>' +
      '<div class="settings-seg" id="set-cust-model">' +
        '<button type="button" data-v="haiku"' + (cMod === 'haiku' ? ' class="on"' : '') + '>Haiku</button>' +
        '<button type="button" data-v="sonnet"' + (cMod === 'sonnet' ? ' class="on"' : '') + '>Sonnet</button>' +
        '<button type="button" data-v="opus"' + (cMod === 'opus' ? ' class="on"' : '') + '>Opus</button>' +
      '</div>' +
      '<div class="settings-seg" id="set-cust-think" style="margin-top:8px">' +
        '<button type="button" data-v="none"' + (cThink === 'none' ? ' class="on"' : '') + '>No&nbsp;thinking</button>' +
        '<button type="button" data-v="low"' + (cThink === 'low' ? ' class="on"' : '') + '>Low</button>' +
        '<button type="button" data-v="high"' + (cThink === 'high' ? ' class="on"' : '') + '>High</button>' +
      '</div>' +
      '<div class="settings-seg" id="set-cust-runner" style="margin-top:8px">' +
        '<button type="button" data-v="local"' + (cRun === 'local' ? ' class="on"' : '') + '>Local</button>' +
        '<button type="button" data-v="api"' + (cRun === 'api' ? ' class="on"' : '') + '>API</button>' +
      '</div>' +

      '<div class="settings-sec">Full agent mode</div>' +
      '<div class="settings-seg" id="set-agent-mode">' +
        '<button type="button" data-v="0"' + (agentOn ? '' : ' class="on"') + '>Off</button>' +
        '<button type="button" data-v="1"' + (agentOn ? ' class="on"' : '') + '>On</button>' +
      '</div>' +
      '<label class="settings-row"><span>Working directory</span>' +
        '<input class="settings-text" type="text" id="set-agent-cwd" placeholder="~" value="' + agentCwd + '"></label>' +

      '<div class="settings-sec">Session</div>' +
      '<label class="settings-row"><span>Idle reset (minutes)</span>' +
        '<input class="settings-num" type="number" min="1" max="240" step="1" inputmode="numeric" id="set-reset-min" value="' + resetMin + '"></label>' +

      '<div class="settings-sec">Trailing silence (seconds)</div>' +
      row('Phone', 'phone_silence_s', sil('phone_silence_s', 3)) +
      row('ESP (Hey&nbsp;Rhasspy)', 'esp_silence_s', sil('esp_silence_s', 3)) +
      row('Mac', 'mac_silence_s', sil('mac_silence_s', 3)) +

      '<div class="settings-sec">Wake-free voice</div>' +
      '<div class="settings-seg" id="set-wf-enabled">' +
        '<button type="button" data-v="0"' + (wfOn ? '' : ' class="on"') + '>Off</button>' +
        '<button type="button" data-v="1"' + (wfOn ? ' class="on"' : '') + '>On</button>' +
      '</div>' +
      '<div class="settings-seg" id="set-wf-route" style="margin-top:8px">' +
        '<button type="button" data-v="fast"' + (wfRoute === 'fast' ? ' class="on"' : '') + '>Efficiency</button>' +
        '<button type="button" data-v="power"' + (wfRoute === 'power' ? ' class="on"' : '') + '>Accuracy</button>' +
        '<button type="button" data-v="custom"' + (wfRoute === 'custom' ? ' class="on"' : '') + '>Custom</button>' +
      '</div>' +
      '<label class="settings-row"><span>Voice-match threshold<br><small>lower = more permissive</small></span>' +
        '<input class="settings-num" type="number" min="0.1" max="0.9" step="0.05" inputmode="decimal" data-key="voiceid_threshold" value="' + wfThresh + '"></label>' +
      '<label class="settings-row"><span>End-of-command pause (s)</span>' +
        '<input class="settings-num" type="number" min="0.5" max="6" step="0.5" inputmode="decimal" data-key="wakefree_pause_s" value="' + wfPause + '"></label>' +

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
    save('chatbox_route', b.dataset.v);
  });
  back.querySelector('#set-wf-enabled').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    back.querySelectorAll('#set-wf-enabled button').forEach((x) => x.classList.toggle('on', x === b));
    save('wakefree_enabled', b.dataset.v);   // listener reacts live via realtime → mic handoff
  });
  back.querySelector('#set-wf-route').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    back.querySelectorAll('#set-wf-route button').forEach((x) => x.classList.toggle('on', x === b));
    save('wakefree_route', b.dataset.v);   // wakefree.py reads it live; listener bridges it to the ESP
  });
  // Custom-route knobs (model / thinking effort / runner) — used by any route set to Custom.
  [['set-cust-model', 'custom_model'], ['set-cust-think', 'custom_think'], ['set-cust-runner', 'custom_runner']]
    .forEach(([id, key]) => back.querySelector('#' + id).addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      back.querySelectorAll('#' + id + ' button').forEach((x) => x.classList.toggle('on', x === b));
      save(key, b.dataset.v);
    }));
  // Full agent mode — toggling either way resets the hub conversation, since the toolset + framing differ
  // and a resumed session shouldn't straddle the switch.
  back.querySelector('#set-agent-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    back.querySelectorAll('#set-agent-mode button').forEach((x) => x.classList.toggle('on', x === b));
    save('agent_mode', b.dataset.v);
    fetch('/api/voice-reset', { method: 'POST' }).catch(() => {});
  });
  back.querySelector('#set-agent-cwd').addEventListener('change', (e) => save('agent_cwd', e.target.value.trim()));
  // Idle reset is shown in minutes but stored in seconds (session_reset_s). No data-key, so the generic
  // positive-number handler below skips it.
  back.querySelector('#set-reset-min').addEventListener('change', (e) => {
    const m = parseInt(e.target.value, 10);
    if (Number.isFinite(m) && m > 0) save('session_reset_s', Math.round(m * 60));
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
