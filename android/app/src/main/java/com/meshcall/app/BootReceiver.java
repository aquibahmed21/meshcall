package com.meshcall.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restart the background connection after a reboot or an app update. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            CallService.start(context, false, false, null);
        } catch (RuntimeException ignored) {
            // the app is opened by the user next time
        }
    }
}
