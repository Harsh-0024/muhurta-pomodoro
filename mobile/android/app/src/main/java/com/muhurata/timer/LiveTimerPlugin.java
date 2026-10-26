package com.muhurata.timer;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import android.widget.RemoteViews;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The running Rhythm, Timer or Flow as an ongoing notification, like the Mac
 * app's menu bar. mobile/web/live.js says what is running whenever it
 * changes; the clock in the notification is an Android Chronometer, so it
 * keeps ticking while the app itself is paused in the background.
 *
 * show({label, up, sec, until, since, paused, plus}): a countdown ends at `until`
 * (ms since 1970); a count-up has run `sec` seconds plus the time since
 * `since`; paused, it stands still at `sec`. plus puts a "+" before the
 * time (past zero). hide() removes it.
 */
@CapacitorPlugin(name = "LiveTimer")
public class LiveTimerPlugin extends Plugin {

    private static final String CHANNEL = "running";
    private static final int ID = 4100;

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Quiet: no sound, no pop-up, no badge. The bells are alerts.js's.
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Running clock", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("The time left while Rhythm, Timer or Flow runs");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
            getContext().getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    @PluginMethod
    public void show(PluginCall call) {
        Context ctx = getContext();
        NotificationManagerCompat manager = NotificationManagerCompat.from(ctx);
        if (!manager.areNotificationsEnabled()) {
            call.resolve(result(false));
            return;
        }
        String label = call.getString("label", "Muhurta");
        boolean up = Boolean.TRUE.equals(call.getBoolean("up", false));
        boolean paused = Boolean.TRUE.equals(call.getBoolean("paused", false));
        // optDouble: times like 1792560000000 arrive as whole numbers (longs),
        // which getDouble does not read.
        double sec = call.getData().optDouble("sec", 0.0);
        double until = call.getData().optDouble("until", 0.0);
        double since = call.getData().optDouble("since", 0.0);

        long now = System.currentTimeMillis();
        long ms; // what the clock shows right now
        if (!up && until > 0) ms = (long) until - now;
        else if (up && since > 0) ms = (long) (sec * 1000) + (now - (long) since);
        else ms = (long) (sec * 1000);
        ms = Math.max(0, ms);
        // The app rounds a countdown up (12:33.4 shows as 12:34); Chronometer
        // rounds down, so give it the rest of the second.
        long shown = up ? ms : ms + 999;
        // The Chronometer counts from `base` on the elapsedRealtime clock.
        long base = up ? SystemClock.elapsedRealtime() - shown : SystemClock.elapsedRealtime() + shown;

        RemoteViews view = new RemoteViews(ctx.getPackageName(), R.layout.notification_live);
        view.setTextViewText(R.id.live_label, label);
        view.setChronometer(R.id.live_clock, base, Boolean.TRUE.equals(call.getBoolean("plus", false)) ? "+%s" : null, !paused);
        view.setChronometerCountDown(R.id.live_clock, !up);

        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_chakra)
            .setColor(0xFFA98237)
            .setStyle(new NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(view)
            .setContentTitle(label)
            .setContentIntent(tap)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        // A countdown can't be updated while the app sleeps: take it away when
        // it reaches zero, where the end-of-block bell takes over.
        if (!up && !paused && ms > 0) b.setTimeoutAfter(ms + 1500);
        try {
            manager.notify(ID, b.build());
            call.resolve(result(true));
        } catch (SecurityException e) { // no permission to post
            call.resolve(result(false));
        }
    }

    @PluginMethod
    public void hide(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(ID);
        call.resolve();
    }

    private static JSObject result(boolean shown) {
        JSObject r = new JSObject();
        r.put("shown", shown);
        return r;
    }
}
