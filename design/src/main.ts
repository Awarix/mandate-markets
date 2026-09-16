// Wiring, and the only file that knows about all the others.
//
// The order below is the order the inline script ran in: chrome first, then the home
// page's illustrations, then the session, then connect. Nothing here decides anything —
// if a line in this file is doing work, it belongs in a module.

import { REDUCE, $, $$ } from "./dom.ts";
import { loadDesk, fetchDesk, wireChart, wireHistory, wireShareWeek, wireSignals, wireTabs } from "./desk.ts";
import { leaveConnect, refreshConnect, wireConnect } from "./connect.ts";
import { relayoutHero, wireBeats, wireReveals } from "./home.ts";
import { loadLeaderboard, wireLeaderboard } from "./leaderboard.ts";
import { captureRef, captureXResult, cleanUrl, wireQueue } from "./queue.ts";
import { getMe, onSignedIn, refreshMe, signIn, signOut } from "./session.ts";
import { wireShareDialog } from "./share.ts";
import { wireMenus } from "./menu.ts";
import { wireTheme } from "./theme.ts";
import { onEnter, onLeave, show, type View } from "./views.ts";

if (!REDUCE) document.documentElement.classList.add("anim");

// What each view does when it is entered, and what connect does when it is left.
// `show()` itself knows none of this — see views.ts for why.
onEnter("home", relayoutHero);
onEnter("desk", () => void loadDesk());
// Settings renders from the same payload as the desk, so entering it is the same call.
// It has its own entry rather than sharing the desk's because `show()` runs exactly one,
// and a settings screen reached directly on a cold cache would otherwise show nothing.
onEnter("settings", () => void loadDesk());
onEnter("connect", () => void refreshConnect());
onEnter("leaderboard", () => void loadLeaderboard());
onLeave("connect", leaveConnect);

$$<HTMLElement>("[data-go]").forEach((b) => {
  b.addEventListener("click", () => show(b.dataset.go as View));
});
// The mark, on both headers. Its own attribute rather than `data-go="home"`: that one
// used to sign the reader out as well as navigate, and a logo must not end a session.
// This only switches the view, so a signed-in reader can read the promo page and come
// back through the header.
$$<HTMLElement>("[data-home]").forEach((b) => {
  b.addEventListener("click", () => show("home"));
});
wireMenus();
wireTheme();
wireQueue();
wireLeaderboard();

// A referral link and the X callback both come back as a query string on the home
// path, and neither should survive into the address bar: a reload of `/?x=taken`
// would re-announce something that happened once, and `?r=` has been banked by then.
captureRef(location.search);
const cameFromX = captureXResult(location.search);
cleanUrl();
wireTabs();
wireChart();
wireSignals();
wireHistory();
wireShareDialog();
wireShareWeek();

wireReveals();
wireBeats();

// Prefetching the desk is the desk's business, not the session's; registered here so
// session.ts does not have to import it.
onSignedIn(() => { fetchDesk().catch(() => {}); });

$("authbtn").addEventListener("click", () => {
  const me = getMe();
  if (!me) return void signIn();
  show(me.connected ? "desk" : "connect");   // same reason as the sign-in landing
});
// Signing out, from either header's menu. It was `#signout` on one and
// `data-go="home"` on the other — and that second attribute is the page's navigation
// hook, so *every* control carrying it ended the session, which is why two other files
// carry a comment warning not to use it for a link. One attribute, one meaning.
$$<HTMLElement>("[data-signout]").forEach((b) => {
  b.addEventListener("click", () => signOut());
});

// Coming back from X's consent screen lands on the home path; the outcome belongs on
// the screen that sent them there — but only once the session is loaded, or the connect
// view paints its signed-out state and then waits for a poll it never scheduled.
void refreshMe().then(() => { if (cameFromX) show("connect"); });

wireConnect(() => void signIn());
