// Entry for index.html. The list and its ORDER are the contract: these modules run for their side
// effects, and each one's own imports are evaluated before it — exactly what a run of separate
// <script type=module> tags did, which is what this replaced. Served raw, this graph costs a round
// trip per import LEVEL before any of it runs; build.js bundles this into
// public/dist/index.js, which is the one script the page actually loads.

import '../core.js';   // renders the REAL hub cards from /api/stream into the .rows
