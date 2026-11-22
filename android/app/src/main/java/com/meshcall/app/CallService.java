package com.meshcall.app;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps MeshCall alive while it is in the background:
 *  - idle   → a low-key "Connected" notification keeps the process (and the signaling socket) alive
 *  - in call→ the notification shows the call and the service declares the microphone/camera
 *             foreground types, so Android keeps capturing audio/video with the screen off.
 * Also holds a partial CPU wake lock and a high-performance Wi-Fi lock so the connection is not
 * put to sleep.
 */
public class CallService extends Service {
    static final String ACTION_UPDATE = "com.meshcall.app.UPDATE";
    static final String ACTION_STOP = "com.meshcall.app.STOP";
    static final String EXTRA_IN_CALL = "inCall";
    static final String EXTRA_VIDEO = "video";
    static final String EXTRA_TEXT = "text";
    static final int NOTIFICATION_ID = 1001;

    private static boolean running = false;
    /** True from MainActivity.onCreate to onDestroy. */
    static volatile boolean activityAlive = false;
    /** True while a call is in progress (set by the web app via the service type). */
    static volatile boolean inCallNow = false;
    static volatile boolean videoNow = false;
    static CallService instance;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    static boolean isRunning() {
        return running;
    }

    static void start(Context ctx, boolean inCall, boolean video, String text) {
        Intent i = new Intent(ctx, CallService.class).setAction(ACTION_UPDATE)
            .putExtra(EXTRA_IN_CALL, inCall).putExtra(EXTRA_VIDEO, video).putExtra(EXTRA_TEXT, text);
        ContextCompat.startForegroundService(ctx, i);
    }

    static void stop(Context ctx) {
        KeepAlive.setWanted(ctx, false);
        ctx.stopService(new Intent(ctx, CallService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            KeepAlive.setWanted(this, false); // an explicit stop must stay stopped
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        boolean inCall = intent != null && intent.getBooleanExtra(EXTRA_IN_CALL, false);
        boolean video = intent != null && intent.getBooleanExtra(EXTRA_VIDEO, false);
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        promote(inCall, video, text);
        acquireLocks();
        running = true;
        instance = this;
        syncHeadless();
        startExternalWatch();
        KeepAlive.setWanted(this, true);
        KeepAlive.schedule(this, KeepAlive.HEARTBEAT_MS);
        return START_STICKY; // Android restarts the service (intent == null) if the process is killed
    }

    private void promote(boolean inCall, boolean video, String text) {
        inCallNow = inCall;
        videoNow = inCall && video;
        NotificationHelper.ensureChannels(this);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, inCall ? NotificationHelper.CH_ONGOING : NotificationHelper.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_meshcall)
            .setContentTitle(inCall ? "MeshCall – call in progress" : "MeshCall")
            .setContentText(text != null && !text.isEmpty() ? text : inCall ? "Tap to return to your call" : "Ready for calls and messages")
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(inCall ? NotificationCompat.CATEGORY_CALL : NotificationCompat.CATEGORY_SERVICE)
            .setPriority(inCall ? NotificationCompat.PRIORITY_DEFAULT : NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        Notification n = b.build();

        if (Build.VERSION.SDK_INT >= 29) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST;
            if (Build.VERSION.SDK_INT >= 34) {
                type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
                if (inCall) {
                    if (granted(Manifest.permission.RECORD_AUDIO)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                    if (video && granted(Manifest.permission.CAMERA)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                }
            } else if (inCall) {
                type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if (video && granted(Manifest.permission.CAMERA)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                if (!granted(Manifest.permission.RECORD_AUDIO)) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST;
            }
            try {
                startForeground(NOTIFICATION_ID, n, type);
                return;
            } catch (RuntimeException e) {
                // e.g. microphone type refused while the app is in the background → keep the plain service
                try {
                    startForeground(NOTIFICATION_ID, n, Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST);
                    return;
                } catch (RuntimeException e2) {
                    // fall through to the legacy call
                }
            }
        }
        startForeground(NOTIFICATION_ID, n);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void acquireLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MeshCall:service");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire();
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wm.createWifiLock(mode, "MeshCall:wifi");
                wifiLock.setReferenceCounted(false);
            }
            if (!wifiLock.isHeld()) wifiLock.acquire();
        } catch (RuntimeException ignored) {
            // locks are best-effort
        }
    }

    /** No Activity → run the web app headless so calls keep arriving; Activity back → stop it. */
    static void syncHeadless() {
        CallService svc = instance;
        if (svc == null) return;
        if (activityAlive) HeadlessHost.stop();
        else if (!HeadlessHost.isRunning()) HeadlessHost.start(svc);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiping MeshCall away from Recents must not end the service: keep listening headless.
        super.onTaskRemoved(rootIntent);
        activityAlive = false;
        syncHeadless();
        KeepAlive.schedule(this, 1500); // some builds kill the process right after this – come back

    }

    // ── operator / WhatsApp-style calls ─────────────────────────────────────
    // Android exposes no "other app is in a call" API, but the global audio mode flips to
    // IN_CALL (carrier) or IN_COMMUNICATION (VoIP) while one is up. No permission needed.
    private final android.os.Handler extHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean extWatching;
    private final Runnable extTick = new Runnable() {
        @Override
        public void run() {
            android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
            int mode = am == null ? android.media.AudioManager.MODE_NORMAL : am.getMode();
            boolean on = !inCallNow && (mode == android.media.AudioManager.MODE_IN_CALL || mode == android.media.AudioManager.MODE_IN_COMMUNICATION || mode == 4);
            MeshCallPlugin.emitExternal(on);
            HeadlessHost.deliverExternal(on);
            extHandler.postDelayed(this, 2000);
        }
    };

    private void startExternalWatch() {
        if (extWatching) return;
        extWatching = true;
        extHandler.post(extTick);
    }

    @Override
    public void onDestroy() {
        extHandler.removeCallbacks(extTick);
        extWatching = false;
        running = false;
        KeepAlive.schedule(this, 2000); // killed or destroyed without an explicit stop → restart
        if (instance == this) instance = null;
        HeadlessHost.stop();
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (RuntimeException ignored) {
        }
        super.onDestroy();
    }
}
