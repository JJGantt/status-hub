// The standalone /calendar page: the month calendar (cards/month.js) with a navbar, for a surface
// that is not the phone's home page. Not on the status stream (it renders none of it); it takes
// `/api/list-stream`, which pushes when a dated item changes.
import { liveStream } from './shared.js';
import { mountNavbar } from './navbar.js';
import { mountMonth } from './cards/month.js';

mountNavbar();
const cal = mountMonth(document.getElementById('calpage'));
window.addEventListener('focus', cal.load);
// Voice edits arrive by push — the hub emits `lists` off its Supabase realtime subscription the
// moment a dated item or a list changes. `load()` re-reads whatever month is in view, so paging is
// preserved. liveStream rather than a bare EventSource: this stream can legitimately carry no data
// for hours, so only the server's `ping` distinguishes quiet from dead.
liveStream('/api/list-stream', { lists: cal.load });
