// The heat-grid columns older than the status frame carries.
//
// The frame's window is fixed (HEAT_WEEKS in server.js) because it is re-pushed on every realtime
// event and history only grows. /api/heat-history serves everything older as a PREFIX — the live
// window stays authoritative, so today's cell and any edit still arrive on the frame with nothing to
// merge cell by cell. Only the expanded sheet is wide enough to scroll through it, so it is fetched
// the first time a sheet opens and kept for the life of the page.

let hist = null, inflight = null, onLoaded = null;

export function onHistoryLoaded(fn) { onLoaded = fn; }

export function loadHistory() {
  if (hist) return Promise.resolve(hist);
  if (inflight) return inflight;
  inflight = fetch('/api/heat-history')
    .then((r) => r.json())
    .then((j) => { hist = j && !j.error ? j : null; inflight = null; if (hist && onLoaded) onLoaded(); return hist; })
    .catch(() => { inflight = null; return null; });
  return inflight;
}

// The live window with its history in front — but only for a grid that is actually inside the open
// sheet. The wall behind it keeps the short window its cell size is tuned for.
export function withHistory(live, key, el, today) {
  const sheet = document.querySelector('.sectsheet.open');
  if (!hist || !el || !sheet || !sheet.contains(el)) return live;
  // The prefix was cut at the frame's window. Once the 4am day rolls over that window has slid a
  // column and the two no longer meet, so drop it and refetch rather than draw a grid with a gap.
  if (today && hist.today !== today) { hist = null; loadHistory(); return live; }
  const pre = hist[key];
  if (!pre || !pre.weeks.length) return live;
  // Months label a column only where the month changes from the column to its left. The live
  // window's first column has nothing to its left on the frame, but does once a prefix is in front.
  const months = pre.months.concat([pre.join_month], (live.months || []).slice(1));
  return Object.assign({}, live, { weeks: pre.weeks.concat(live.weeks || []), months });
}

// Pin a grid to its newest column — the right edge. Called on open, and again when history lands
// and widens it.
export function pinRight(el) {
  if (el) el.scrollLeft = el.scrollWidth;
}
