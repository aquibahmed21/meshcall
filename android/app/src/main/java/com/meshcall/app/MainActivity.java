package com.meshcall.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable keepVisible = new Runnable() {
        @Override
        public void run() {
            // Chromium throttles/suspends a WebView whose window is hidden. Telling it that it is
            // still visible keeps timers, WebSockets and WebRTC running while the app is in the
            // background (the foreground service keeps the process alive).
            if (bridge != null && bridge.getWebView() != null) bridge.getWebView().dispatchWindowVisibilityChanged(View.VISIBLE);
            handler.postDelayed(this, 1500);
        }
    };

    private boolean lockAccess = false;
    private long lockAccessSince = 0;
    /** Privacy: the app may only sit above the lock screen while a call is being answered/held. */
    private final Runnable lockWatch = new Runnable() {
        @Override
        public void run() {
            if (!lockAccess) return;
            boolean grace = System.currentTimeMillis() - lockAccessSince < 20000;
            if (CallService.inCallNow || grace) handler.postDelayed(this, 1000);
            else revokeLockAccess();
        }
    };

    private void grantLockAccess() {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        lockAccess = true;
        lockAccessSince = System.currentTimeMillis();
        handler.removeCallbacks(lockWatch);
        handler.postDelayed(lockWatch, 1000);
    }

    private void revokeLockAccess() {
        handler.removeCallbacks(lockWatch);
        if (!lockAccess) return;
        lockAccess = false;
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        CallService.activityAlive = true;
        HeadlessHost.stop(); // the real UI takes over the connection
        registerPlugin(MeshCallPlugin.class);
        registerPlugin(getcapacitor.community.contacts.ContactsPlugin.class);
        super.onCreate(savedInstanceState);
        // Hardware volume keys always control the MEDIA volume, which is what call audio plays on.
        setVolumeControlStream(android.media.AudioManager.STREAM_MUSIC);
        handleNotificationIntent(getIntent(), true);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(keepVisible);
        super.onDestroy();
        if (!isChangingConfigurations()) {
            CallService.activityAlive = false;
            KeepAlive.schedule(this, 3000);
            // The screen is gone (Recents cleared): keep the connection alive without it.
            if (CallService.isRunning()) CallService.syncHeadless();
            else CallService.start(getApplicationContext(), false, false, null);
        }
    }

    /** Home/recents during a video call → shrink into a floating picture-in-picture window. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (pipEligible) enterPip();
    }

    static volatile boolean pipEligible = false;

    private android.app.PictureInPictureParams pipParams() {
        android.app.PictureInPictureParams.Builder b = new android.app.PictureInPictureParams.Builder().setAspectRatio(new android.util.Rational(9, 16));
        // Android 12+: swiping up / pressing Home enters PiP by itself (smooth gesture-navigation animation).
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(pipEligible).setSeamlessResizeEnabled(false);
        return b.build();
    }

    /** Video call on/off: arms (or disarms) automatic picture-in-picture. */
    void setPipEligible(boolean on) {
        pipEligible = on;
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            setPictureInPictureParams(pipParams());
        } catch (RuntimeException ignored) {
        }
    }

    void enterPip() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            enterPictureInPictureMode(pipParams());
        } catch (RuntimeException e) {
            android.util.Log.w("MeshCall", "PiP refused: " + e.getMessage());
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, android.content.res.Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        MeshCallPlugin.emitPip(isInPictureInPictureMode);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNotificationIntent(intent, false);
    }

    @Override
    public void onStop() {
        super.onStop();
        revokeLockAccess();
        handler.removeCallbacks(keepVisible);
        handler.postDelayed(keepVisible, 300);
    }

    @Override
    public void onStart() {
        super.onStart();
        handler.removeCallbacks(keepVisible);
    }

    private void handleNotificationIntent(Intent intent, boolean cold) {
        if (intent == null) return;
        String tag = intent.getStringExtra(NotificationHelper.EXTRA_TAG);
        if (tag == null) return;
        String action = intent.getStringExtra(NotificationHelper.EXTRA_ACTION);
        if ("decline".equals(action)) {
            // Declining must never leave the app reachable from the lock screen.
            revokeLockAccess();
            moveTaskToBack(true);
        } else {
            // A call should light up and show over the lock screen – only until it is over.
            grantLockAccess();
        }
        String data = intent.getStringExtra(NotificationHelper.EXTRA_DATA);
        intent.removeExtra(NotificationHelper.EXTRA_TAG);
        NotificationHelper.cancel(this, tag);
        MeshCallPlugin.deliver(tag, action == null ? "open" : action, data, cold);
    }
}
