package com.meshcall.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * Self-restart safety net. Some Android builds kill the process when the screen is closed or the
 * task is removed, even with every permission granted. An exact, idle-exempt alarm brings the
 * foreground service (and with it the headless connection) back, and keeps re-arming itself as a
 * heartbeat while the user wants MeshCall to stay reachable.
 */
final class KeepAlive {
    private static final String PREFS = "meshcall.keepalive";
    private static final String KEY_ON = "on";
    static final long HEARTBEAT_MS = 5 * 60_000L;

    private KeepAlive() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean wanted(Context c) {
        return prefs(c).getBoolean(KEY_ON, false);
    }

    /** The user wants calls to keep arriving (service started) / explicitly stopped it. */
    static void setWanted(Context c, boolean on) {
        prefs(c).edit().putBoolean(KEY_ON, on).apply();
        if (!on) cancel(c);
    }

    private static PendingIntent pending(Context c) {
        Intent i = new Intent(c, KeepAliveReceiver.class).setAction("com.meshcall.app.KEEP_ALIVE");
        return PendingIntent.getBroadcast(c, 4711, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void schedule(Context ctx, long delayMs) {
        Context c = ctx.getApplicationContext();
        if (!wanted(c)) return;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long at = System.currentTimeMillis() + delayMs;
        PendingIntent pi = pending(c);
        try {
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    static void cancel(Context ctx) {
        Context c = ctx.getApplicationContext();
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pending(c));
    }
}
