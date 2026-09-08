// Entry for index.html. The list and its ORDER are the contract: these modules run for their side
// effects, and each one's own imports are evaluated before it — exactly what a run of separate
// <script type=module> tags did, which is what this replaced. Twenty-six files arriving in three
// waterfall levels cost a round trip per level on a phone; build.js bundles this into
// public/dist/index.js, which is the one script the page actually loads.

import '../core.js';   // renders the REAL hub cards from /api/stream into the .rows
