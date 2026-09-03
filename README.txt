# mrf-relay-service

A standalone Express server that handles Server 4 (MRF SMS) number
purchases directly, on a Heroku dyno instead of Vercel. Heroku allows up
to ~30s per request, unlike Vercel's free plan which hard-kills anything
over ~10s. **The frontend calls this service directly for the "buy a
Server 4 number" step** — not through Vercel — because Vercel's own
10-second limit would still apply even if Vercel just sat there waiting
for Heroku's answer. Everything else (login, wallet top-ups, Server
1/2/3, checking for OTPs, releasing numbers, admin panel) stays on Vercel
exactly as before; this service only replaces the one specific step that
kept timing out.

## Environment variables to set on Heroku

```
heroku config:set VITE_SUPABASE_URL=https://your-project.supabase.co
heroku config:set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Use the **exact same values** already set in your Vercel project's
environment variables (Vercel dashboard → your project → Settings →
Environment Variables) — copy them over, don't generate new ones.

## Deploy to Heroku (using your friend's paid account)

1. Make sure you have the Heroku CLI installed, and your friend has added
   you as a collaborator on the app (or just deploy from their machine).

2. From inside this folder:
   ```
   heroku create numera-mrf-relay
   ```
   (pick any available name — this becomes part of the URL, e.g.
   `https://numera-mrf-relay.herokuapp.com`)

3. Set the two Supabase env vars shown above.

4. **Important — pick a plan that doesn't sleep.** If the app is created
   on an Eco dyno by default, upgrade it to Basic so it never sleeps
   (a sleeping dyno's first request afterward takes several extra
   seconds to wake up, which defeats the purpose of this whole service):
   ```
   heroku ps:type basic
   ```

5. Deploy:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   heroku git:remote -a numera-mrf-relay
   git push heroku main
   ```

6. Confirm it's running:
   ```
   curl https://numera-mrf-relay.herokuapp.com/
   ```
   should return `{"ok":true,"service":"mrf-relay-service"}`

## After deploying

Give Claude the Heroku app's URL (e.g.
`https://numera-mrf-relay.herokuapp.com`) — that's the only thing needed
to wire up the frontend's "Buy Number" button for Server 4 to call this
service instead of Vercel for that one step.
