// Entry for phone-home.html. The list and its ORDER are the contract: these modules run for their
// side effects, and each one's own imports are evaluated before it. build.js bundles this graph into
// public/dist/phone-home.js, which is the one script the page actually loads.
//
// No tv.js and no wall.js, and both absences are deliberate. tv.js is the kiosk's display-only voice
// layer, and this page boots the interactive client (voiceagent) instead — running both is what put
// two EventSources on one phone. wall.js scales a 1920x1080 canvas down to phone size; this page is
// laid out at the phone's own size and has nothing to scale, so its paging lives in phone-home.js.
import '../core.js';   // renders the REAL hub cards from /api/stream into the .rows
import '../expand.js';   // tap what summarises a section -> its full-screen sheet
import '../phone-home.js';   // this page's own middle -- the week, the sessions list, the conversation tail
import '../inbox.js';   // the inbox: the dot on the conversation, its list, one answer on its own
import '../alarmclock.js';   // rings on this page, since the iOS app is what has it open
import '../audiotest.js';   // sound bench on the reports pane — which audio path survives Guided Access
import '../cards/livemic.js';   // the live mic's Stream button in Utilities (the app does the capture)
