World Flight Simulator (assembled copy) - how to run
1. Unzip so index.html sits next to the css/, js/, images/ folders.
2. Open a terminal in this folder and run:  python3 -m http.server 8000
   (or: npx serve)
3. Visit http://localhost:8000 in Chrome/Edge. Do NOT double-click index.html
   (ES modules and the import map need http://, not file://).
4. Needs internet (Three.js, map tiles, fonts load from CDNs).
Not included in the originals: blog/, guide.html, contact.html, and the backend
(accounts, multiplayer, live traffic) - those features won't work locally.
Code (c) World Flight Simulator / Simon - used and edited with his permission; keep credit.

787-9 model integration:
- The previous 777-300ER model slot now uses the supplied Boeing 787-9 Singapore Airlines model.
- The model includes an authored landing-gear animation; engine fan blades are throttle-driven.
- Model attribution and the original CC-BY-4.0 license are in assets/CREDITS.txt and assets/boeing_787_9_singapore/license.txt.
