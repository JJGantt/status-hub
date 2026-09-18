// The session wall: which sessions are running, and what the focused one last said.
//
// It draws NOTHING of its own. `cards/sessions.js` is the one module every surface that shows sessions
// uses — the home wall, the phone's home page and this — because the numbering is what Jared says out
// loud ("focus the second session"), and two copies of that ordering are two surfaces that can
// disagree about which session "the second one" is. The same module is also why the pin, the unread
// mark and the live activity line arrive here without this file knowing they exist.
//
// What is left here is the SHAPE: this wall lays the same `.hw-row` markup out as a row of tabs
// across the top (tv-focus.css), with the focused session's answer filling the rest of the screen.
// A wall is read across a room, so the list is short and the answer is large.
import { mountSessions } from './cards/sessions.js';

// Five, not the wall default of three: this wall is nothing BUT sessions, so the room the list takes
// is not being taken from anything else. The home wall keeps three because its column is shared.
mountSessions({
  list: document.getElementById('sf-tabs'),
  head: document.getElementById('sf-head'),
  reply: document.getElementById('sf-reply'),
  max: 5,
});
