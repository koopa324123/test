// WHAT KIND OF DEVICE IS THIS — the single source of truth.
//
// There used to be TWO different answers living in four files, and they
// disagreed. main.js asked "(pointer: coarse) || 'ontouchstart' in window";
// traffic.js, photoreal.js and city3d.js asked "maxTouchPoints > 2". On a
// touchscreen DESKTOP the second says phone and the first says desktop, so the
// machine got desktop controls and a full-quality world while quietly running
// the phone budget for live traffic — 8 aircraft models instead of 24. It hid
// for weeks because nothing about the UI looked wrong.
//
// The real lesson is that "is this a phone" was never one question. It is two,
// and they have different answers on the same machine:
//
//   isTouchUI     — does the player need ON-SCREEN controls? A tablet with no
//                   keyboard does, even though it is powerful.
//   isMobileGpu   — should this run REDUCED graphics budgets? A Surface with a
//                   mouse should not, even though it has a touchscreen.
//
// Naming them separately is the fix. Anything importing these should pick the
// one that matches the actual decision being made, never "the mobile flag".

const _params = new URLSearchParams(location.search);

// ?touch=1 forces the touch build on a desktop, for testing the phone UI.
export const FORCE_TOUCH = _params.has('touch');

// A real pointing device — mouse, trackpad, stylus with hover. `any-pointer`
// (not `pointer`) asks whether ANY attached input is fine, which is what
// distinguishes a touchscreen PC from a tablet.
const hasFinePointer = () => matchMedia('(any-pointer: fine)').matches;

// Touch is the PRIMARY input. False on a touchscreen desktop driven by a mouse.
const touchIsPrimary = () => matchMedia('(pointer: coarse)').matches;

// Phones and tablets by user-agent. iPadOS 13+ reports itself as "Macintosh",
// so a Mac UA carrying real touch points is an iPad, not a MacBook — Apple
// laptops have zero touch points, including the ones with a Touch Bar.
const uaIsMobile = () =>
  /Android|iPhone|iPod|Mobi|Windows Phone|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
  /iPad/i.test(navigator.userAgent) ||
  (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 2);

// ---------------------------------------------------------------------------
// ON-SCREEN CONTROLS NEEDED?
//
// Deliberately GENEROUS: the failure it prevents is a tablet with no keyboard
// and no on-screen stick, which is a player who cannot fly at all. Showing a
// touch UI to someone who also has a mouse costs them a little screen space.
// Those are not comparable, so this keeps the old, wider test unchanged.
// ---------------------------------------------------------------------------
export const isTouchUI = FORCE_TOUCH || touchIsPrimary() || 'ontouchstart' in window;

// ---------------------------------------------------------------------------
// REDUCED GRAPHICS BUDGETS?
//
// Deliberately STRICT, because the failure it prevents is the opposite one: a
// capable PC silently running phone settings. True only for hardware that is
// actually mobile — a mobile user-agent, or a touch-primary device with NO
// fine pointer attached at all.
//
// ?touch=1 forces this too, so the flag still previews the full phone build.
// ---------------------------------------------------------------------------
export const isMobileGpu = FORCE_TOUCH || uaIsMobile() || (touchIsPrimary() && !hasFinePointer());
