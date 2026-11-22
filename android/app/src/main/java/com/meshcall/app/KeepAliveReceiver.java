package com.meshcall.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Alarm tick: make sure the background connection is running, then arm the next tick. */
public class KeepAliveReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!KeepAlive.wanted(context)) return;
        try {
            if (!CallService.isRunning()) CallService.start(context, false, false, null);
        } catch (RuntimeException ignored) {
            // Starting a foreground service from the background can be refused; the next tick retries.
        }
        KeepAlive.schedule(context, KeepAlive.HEARTBEAT_MS);
    }
}
