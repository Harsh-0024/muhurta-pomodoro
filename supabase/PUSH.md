# iPhone notifications: one-time setup

The iPhone app is a web app, and iOS stops a web app the moment it leaves the
screen. To still get a bell and a notification when a focus or rest block ends
with the phone locked, the app books the end time with a small Supabase
function as it leaves the screen, and the function sends a Web Push through
Apple at that time. Everything runs on the free Supabase plan; there is no
Apple developer account involved.

Until these steps are done, the iPhone app still works: it simply keeps the
screen on while a timer runs, as before.

## 1. Make the keys (once)

    node supabase/functions/push/make-keys.mjs

It prints two lines, `VAPID_PUBLIC_KEY=...` and `VAPID_PRIVATE_KEY=...`. Keep
them in your password manager next to the Android key. The private one is a
secret; never commit it.

## 2. Give them to Supabase

Supabase dashboard -> **Edge Functions -> Secrets** (or Project Settings ->
Edge Functions), add:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the public key from step 1 |
| `VAPID_PRIVATE_KEY` | the private key from step 1 |

(`VAPID_SUBJECT` is optional: who Apple can contact about these pushes,
`mailto:muhurata.pomodoro.timer@gmail.com` unless you set another.)

## 3. Deploy the function

From the repository folder, on your Mac (Node is enough, nothing to install):

    npx supabase login
    npx supabase functions deploy push --project-ref ybjyzvtilicsncuiujks --no-verify-jwt

`--no-verify-jwt` matters: the phone books its notification as it leaves the
screen, without signing in. Check it is up: opening
https://ybjyzvtilicsncuiujks.supabase.co/functions/v1/push in a browser shows
`{"publicKey":"..."}` with your public key.

## 4. Create the table and the schedule

Supabase dashboard -> **SQL Editor -> New query**, paste all of
[`push.sql`](push.sql), **Run**. (If it says pg_cron or pg_net is not
available, turn them on under Database -> Extensions first, then run again.)

## 5. Try it on an iPhone

1. Open https://harsh-0024.github.io/muhurta-pomodoro/app/ in Safari, Share ->
   Add to Home Screen, open it from the Home Screen and sign in.
   (iOS 16.4 or later. Notifications only work from the Home Screen app, not in
   a Safari tab.)
2. Settings -> Notifications: turn it on and tap **Allow**, then **Allow** on
   the iPhone's question.
3. **Send a test**, then lock the phone: the notification arrives within about
   15 seconds.
4. Start a 1-minute Timer and lock the phone: the notification arrives when it
   ends.

## How to see it working

- Supabase -> Edge Functions -> push -> **Logs**: each send, and any failure.
- SQL: `select * from push_bookings;` shows bookings waiting (normally empty or
  one row per phone with a timer running in the background).
- SQL: `select * from cron.job_run_details order by start_time desc limit 5;`
  shows the 10-second check running.

## Costs and limits

- The schedule calls the function only when something is due, so it uses a few
  calls per finished block, far inside the free plan's 500,000 a month.
- Notifications arrive within about 10 seconds of the block's end.
- One block at a time: like the Android app, only the end of the block that is
  running as the app leaves the screen is booked. If Rhythm starts the next
  block by itself, that one rings when you open the app again.
- To turn it all off: `select cron.unschedule('muhurta-push');`. The app then
  falls back to keeping the screen on.
