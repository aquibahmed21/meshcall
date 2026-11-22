package com.meshcall.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/** Channels and builders for MeshCall's native notifications. */
final class NotificationHelper {
    static final String CH_CALLS = "calls";
    static final String CH_MESSAGES = "messages_v2"; // v2: channel settings are frozen once created, vibration was added
    static final String CH_SERVICE = "service";
    static final String CH_ONGOING = "ongoing";
    static final String EXTRA_TAG = "mc_tag";
    static final String EXTRA_ACTION = "mc_action";
    static final String REPLY_KEY = "mc_reply";
    static final String EXTRA_DATA = "mc_data";

    private NotificationHelper() {}

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        AudioAttributes aa = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();

        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Rings when someone calls you or invites you to a stream");
        calls.setSound(ring, aa);
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] {0, 800, 600, 800, 600, 800});
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(calls);

        nm.deleteNotificationChannel("messages");
        NotificationChannel msgs = new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        msgs.setDescription("New direct messages and missed calls");
        msgs.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        msgs.enableVibration(true);
        msgs.setVibrationPattern(new long[] {0, 250, 120, 250});
        nm.createNotificationChannel(msgs);

        NotificationChannel svc = new NotificationChannel(CH_SERVICE, "Background connection", NotificationManager.IMPORTANCE_MIN);
        svc.setDescription("Keeps MeshCall connected so calls can ring while the app is in the background");
        svc.setShowBadge(false);
        nm.createNotificationChannel(svc);

        NotificationChannel ongoing = new NotificationChannel(CH_ONGOING, "Ongoing call", NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription("Shown while a call is in progress");
        ongoing.setShowBadge(false);
        nm.createNotificationChannel(ongoing);
    }

    static int idFor(String tag) {
        return 2000 + (tag.hashCode() & 0x0fffffff);
    }

    private static PendingIntent open(Context ctx, int id, String tag, String action, String data) {
        Intent i = new Intent(ctx, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_TAG, tag).putExtra(EXTRA_ACTION, action).putExtra(EXTRA_DATA, data);
        return PendingIntent.getActivity(ctx, id, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent broadcast(Context ctx, int id, String tag, String action, String data) {
        Intent i = new Intent(ctx, NotificationActionReceiver.class)
            .setAction("com.meshcall.app.NOTIFICATION_ACTION." + action + "." + tag)
            .putExtra(EXTRA_TAG, tag).putExtra(EXTRA_ACTION, action).putExtra(EXTRA_DATA, data);
        return PendingIntent.getBroadcast(ctx, id + action.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** kind: "call" (rings, full-screen, Open/Decline) | "live" (Open) | anything else (heads-up message). */
    static void show(Context ctx, String tag, String title, String body, String kind, String data, long timeoutMs) {
        ensureChannels(ctx);
        int id = idFor(tag);
        boolean call = "call".equals(kind) || "live".equals(kind);
        PendingIntent content = open(ctx, id, tag, "open", data);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, call ? CH_CALLS : CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_meshcall)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(content)
            .setAutoCancel(!call)
            .setWhen(System.currentTimeMillis())
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_HIGH);
        if (call) {
            b.setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setFullScreenIntent(content, true)
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
                .setVibrate(new long[] {0, 800, 600, 800, 600, 800})
                .addAction(0, "call".equals(kind) ? "Accept" : "Watch", open(ctx, id + 7, tag, "accept", data));
            if ("call".equals(kind)) b.addAction(0, "Decline", broadcast(ctx, id, tag, "decline", data));
            if (timeoutMs > 0) b.setTimeoutAfter(timeoutMs);
        } else {
            if ("missed".equals(kind)) b.addAction(0, "Call back", open(ctx, id + 9, tag, "callback", data));
            if ("message".equals(kind) || "missed".equals(kind)) {
                androidx.core.app.RemoteInput ri = new androidx.core.app.RemoteInput.Builder(REPLY_KEY).setLabel("Reply").build();
                Intent ri_i = new Intent(ctx, NotificationActionReceiver.class)
                    .setAction("com.meshcall.app.NOTIFICATION_ACTION.reply." + tag)
                    .putExtra(EXTRA_TAG, tag).putExtra(EXTRA_ACTION, "reply").putExtra(EXTRA_DATA, data);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (android.os.Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent rp = PendingIntent.getBroadcast(ctx, id + 11, ri_i, flags);
                b.addAction(new NotificationCompat.Action.Builder(0, "Reply", rp).addRemoteInput(ri).setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).build());
            }
            b.setCategory(NotificationCompat.CATEGORY_MESSAGE).setVibrate(new long[] {0, 250, 120, 250});
        }
        android.app.Notification n = b.build();
        if (call) n.flags |= android.app.Notification.FLAG_INSISTENT; // sound + vibration repeat until answered/declined
        ctx.getSystemService(NotificationManager.class).notify(id, n);
    }

    static void cancel(Context ctx, String tag) {
        ctx.getSystemService(NotificationManager.class).cancel(idFor(tag));
    }
}
