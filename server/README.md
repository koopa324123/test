# Tower AI server

1. Install Node 18 or newer.
2. Start the server (replace the values):

```
ANTHROPIC_API_KEY=sk-ant-... ATC_SECRET=choose-a-long-random-string ATC_ORIGIN=https://your-game-page.example node atc-server.mjs
```

3. In another terminal, open a tunnel:

```
cloudflared tunnel --url http://localhost:8787
```

4. Copy the `https://....trycloudflare.com` address into `ATC_AI_URL` in `js/atc-ai.js`,
   and the same secret into `ATC_AI_SECRET`.

Notes:
- `ATC_ORIGIN` must match the page the game runs on, so other sites can't use your key.
- The secret is sent from the game, so anyone who reads the game files can see it. It stops
  casual use, not a determined one. The rate limit and daily cap limit the cost.
- The model only ever chooses a numbered option that was on the controller's screen.
