// /handoff/:id — the tap screen on its own, for a notification or a link.
import { openHandoff } from '../handoff.js';

const id = location.pathname.split('/').pop();
openHandoff(id, { page: true });
