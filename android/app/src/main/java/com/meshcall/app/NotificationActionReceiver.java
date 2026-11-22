package com.meshcall.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Decline" button on a call notification: dismiss it and tell the web app, without opening the UI. */
public class NotificationActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String tag = intent.getStringExtra(NotificationHelper.EXTRA_TAG);
        String action = intent.getStringExtra(NotificationHelper.EXTRA_ACTION);
        String data = intent.getStringExtra(NotificationHelper.EXTRA_DATA);
        if (tag == null) return;
        NotificationHelper.cancel(context, tag);
        String a = action == null ? "open" : action;
        if ("reply".equals(a)) {
            android.os.Bundle in = androidx.core.app.RemoteInput.getResultsFromIntent(intent);
            CharSequence text = in == null ? null : in.getCharSequence(NotificationHelper.REPLY_KEY);
            if (text == null || text.toString().trim().isEmpty()) return;
            try {
                org.json.JSONObject o = new org.json.JSONObject(data == null ? "{}" : data);
                o.put("replyText", text.toString());
                data = o.toString();
            } catch (org.json.JSONException e) {
                return;
            }
        }
        if (!HeadlessHost.deliver(tag, a, data)) MeshCallPlugin.deliver(tag, a, data, false);
    }
}
