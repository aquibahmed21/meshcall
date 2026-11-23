package com.meshcall.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.PermissionState;

/** JS bridge: background service, native call/message notifications, battery-optimisation exemption. */
@CapacitorPlugin(
    name = "MeshCallNative",
    permissions = {
        @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS}),
        @Permission(alias = "camera", strings = {Manifest.permission.CAMERA}),
        @Permission(alias = "microphone", strings = {Manifest.permission.RECORD_AUDIO}),
        @Permission(alias = "bluetooth", strings = {Manifest.permission.BLUETOOTH_CONNECT}),
        @Permission(alias = "contacts", strings = {Manifest.permission.READ_CONTACTS})
    }
)
public class MeshCallPlugin extends Plugin {
    private static MeshCallPlugin instance;
    private static String[] pendingLaunch; // {tag, action, data} from a cold start / notification tap

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        stopRingtone();
        setProximity(false);
        if (instance == this) instance = null;
    }

    // ── screen sharing (MediaProjection → JPEG frames → web app) ──────────────
    static void emitScreenFrame(String b64, int w, int h) {
        MeshCallPlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("data", b64);
        o.put("w", w);
        o.put("h", h);
        p.notifyListeners("screenFrame", o);
    }

    static void emitScreenEnded() {
        if (instance != null) instance.notifyListeners("screenEnded", new JSObject());
    }

    static void emitExternal(boolean on) {
        if (instance == null) return;
        JSObject o = new JSObject();
        o.put("on", on);
        instance.notifyListeners("externalCall", o);
    }

    static void emitPip(boolean on) {
        if (instance == null) return;
        JSObject o = new JSObject();
        o.put("on", on);
        instance.notifyListeners("pipChanged", o);
    }

    /** Write a shared file into the public Downloads folder (WebView cannot download blob: URLs). */
    /** Vendor screens that decide whether the app may start itself / run in the background. */
    @PluginMethod
    public void openAutostart(PluginCall call) {
        String[][] targets = {
            {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
            {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
            {"com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"},
            {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
            {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"},
            {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
            {"com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"},
            {"com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"},
            {"com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"},
            {"com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"},
        };
        android.content.Context ctx = getContext();
        boolean opened = false;
        for (String[] t : targets) {
            android.content.Intent i = new android.content.Intent().setComponent(new android.content.ComponentName(t[0], t[1])).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            if (i.resolveActivity(ctx.getPackageManager()) == null) continue;
            try {
                ctx.startActivity(i);
                opened = true;
                break;
            } catch (Exception ignored) {
            }
        }
        if (!opened) {
            try {
                android.content.Intent i = new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + ctx.getPackageName())).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                opened = true;
            } catch (Exception ignored) {
            }
        }
        JSObject o = new JSObject();
        o.put("opened", opened);
        call.resolve(o);
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name", "file");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        try {
            byte[] bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT);
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            android.content.ContentResolver cr = getContext().getContentResolver();
            android.content.ContentValues v = new android.content.ContentValues();
            v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safe);
            v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS + "/MeshCall");
            android.net.Uri uri = cr.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new java.io.IOException("insert failed");
            try (java.io.OutputStream out = cr.openOutputStream(uri)) {
                out.write(bytes);
            }
            JSObject o = new JSObject();
            o.put("ok", true);
            call.resolve(o);
        } catch (Exception e) {
            JSObject o = new JSObject();
            o.put("ok", false);
            call.resolve(o);
        }
    }

    @PluginMethod
    public void setPipEligible(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (getActivity() instanceof MainActivity) getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).setPipEligible(on));
        call.resolve();
    }

    @PluginMethod
    public void enterPip(PluginCall call) {
        if (getActivity() instanceof MainActivity) getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).enterPip());
        call.resolve();
    }

    @PluginMethod
    public void startScreenShare(PluginCall call) {
        android.media.projection.MediaProjectionManager mpm = (android.media.projection.MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "screenShareResult");
    }

    @ActivityCallback
    private void screenShareResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.reject("denied");
            return;
        }
        Intent s = new Intent(getContext(), ScreenShareService.class).putExtra("code", result.getResultCode()).putExtra("data", result.getData());
        androidx.core.content.ContextCompat.startForegroundService(getContext(), s);
        call.resolve();
    }

    @PluginMethod
    public void stopScreenShare(PluginCall call) {
        ScreenShareService.stop(getContext());
        call.resolve();
    }

    /**
     * Called by MainActivity / the receiver. cold=true (app launched by the tap) → keep it until the
     * web app asks for it; otherwise hand it to the running web app right away.
     */
    static void deliver(String tag, String action, String data, boolean cold) {
        if (!cold && instance != null) {
            JSObject o = new JSObject();
            o.put("tag", tag);
            o.put("action", action);
            o.put("data", data);
            instance.notifyListeners("notificationAction", o, true);
        } else {
            pendingLaunch = new String[] {tag, action, data};
        }
    }

    @PluginMethod
    public void consumeLaunchAction(PluginCall call) {
        JSObject o = new JSObject();
        if (pendingLaunch != null) {
            o.put("tag", pendingLaunch[0]);
            o.put("action", pendingLaunch[1]);
            o.put("data", pendingLaunch[2]);
            pendingLaunch = null;
        }
        call.resolve(o);
    }

    @PluginMethod
    public void startService(PluginCall call) {
        try {
            CallService.start(getContext(), call.getBoolean("inCall", false), call.getBoolean("video", false), call.getString("text"));
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Could not start the background service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        CallService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void show(PluginCall call) {
        String tag = call.getString("tag");
        if (tag == null) {
            call.reject("tag required");
            return;
        }
        Long timeout = call.getLong("timeoutMs", 0L);
        NotificationHelper.show(getContext(), tag, call.getString("title", "MeshCall"), call.getString("body", ""),
            call.getString("kind", "message"), call.getString("data", "{}"), timeout == null ? 0 : timeout);
        call.resolve();
    }

    private android.media.Ringtone ringtone;

    /** In-app ringing on the RINGER volume (honours silent/vibrate mode), not the media volume. */
    @PluginMethod
    public void startRinging(PluginCall call) {
        try {
            stopRingtone();
            Uri uri = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE);
            ringtone = android.media.RingtoneManager.getRingtone(getContext(), uri);
            if (ringtone != null) {
                ringtone.setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC).build());
                if (Build.VERSION.SDK_INT >= 28) ringtone.setLooping(true);
                ringtone.play();
            }
            startRingVibration();
        } catch (RuntimeException ignored) {
        }
        call.resolve();
    }

    @PluginMethod
    public void stopRinging(PluginCall call) {
        stopRingtone();
        call.resolve();
    }

    private android.os.Vibrator ringVibrator;

    /** Vibrate while ringing (repeats), unless the phone is on silent. Normal and vibrate modes vibrate. */
    private void startRingVibration() {
        try {
            android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am.getRingerMode() == android.media.AudioManager.RINGER_MODE_SILENT) return;
            ringVibrator = (android.os.Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
            if (ringVibrator == null || !ringVibrator.hasVibrator()) return;
            long[] pattern = {0, 800, 600, 800, 600};
            if (Build.VERSION.SDK_INT >= 26) ringVibrator.vibrate(android.os.VibrationEffect.createWaveform(pattern, 0), new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            else ringVibrator.vibrate(pattern, 0);
        } catch (RuntimeException ignored) {
        }
    }

    private void stopRingtone() {
        try {
            if (ringVibrator != null) ringVibrator.cancel();
        } catch (RuntimeException ignored) {
        }
        ringVibrator = null;
        try {
            if (ringtone != null) ringtone.stop();
        } catch (RuntimeException ignored) {
        }
        ringtone = null;
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String tag = call.getString("tag");
        if (tag != null) NotificationHelper.cancel(getContext(), tag);
        call.resolve();
    }

    private String notificationState() {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            return getPermissionState("notifications") == PermissionState.DENIED ? "denied" : "prompt";
        }
        return androidx.core.app.NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
    }

    @PluginMethod
    public void notificationPermission(PluginCall call) {
        JSObject o = new JSObject();
        o.put("state", notificationState());
        call.resolve(o);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
        } else {
            notificationPermission(call);
        }
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        notificationPermission(call);
    }

    private String runtimeState(String alias, int minSdk) {
        if (Build.VERSION.SDK_INT < minSdk) return "granted";
        PermissionState st = getPermissionState(alias);
        return st == PermissionState.GRANTED ? "granted" : st == PermissionState.DENIED ? "denied" : "prompt";
    }

    /** Everything MeshCall needs, in one call: granted | denied | prompt. */
    @PluginMethod
    public void permissionStatus(PluginCall call) {
        JSObject o = new JSObject();
        o.put("microphone", runtimeState("microphone", 23));
        o.put("camera", runtimeState("camera", 23));
        o.put("bluetooth", runtimeState("bluetooth", 31));
        o.put("contacts", runtimeState("contacts", 23));
        o.put("notifications", notificationState());
        boolean fs = true;
        if (Build.VERSION.SDK_INT >= 34) fs = getContext().getSystemService(android.app.NotificationManager.class).canUseFullScreenIntent();
        o.put("fullScreen", fs ? "granted" : "denied");
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        o.put("battery", pm.isIgnoringBatteryOptimizations(getContext().getPackageName()) ? "granted" : "denied");
        call.resolve(o);
    }

    /** Ask for the runtime permissions that are not granted yet (system dialogs, one after another). */
    @PluginMethod
    public void requestRuntimePermissions(PluginCall call) {
        java.util.List<String> need = new java.util.ArrayList<>();
        if (!"granted".equals(runtimeState("microphone", 23))) need.add("microphone");
        if (!"granted".equals(runtimeState("camera", 23))) need.add("camera");
        if (!"granted".equals(runtimeState("bluetooth", 31))) need.add("bluetooth");
        if (!"granted".equals(runtimeState("contacts", 23))) need.add("contacts");
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) need.add("notifications");
        if (need.isEmpty()) {
            permissionStatus(call);
            return;
        }
        requestPermissionForAliases(need.toArray(new String[0]), call, "runtimePermissionsResult");
    }
    private static String deviceName(int type) {
        switch (type) {
            case android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "earpiece";
            case android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "speaker";
            case android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case android.media.AudioDeviceInfo.TYPE_USB_HEADSET: return "wired";
            case android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case android.media.AudioDeviceInfo.TYPE_BLE_HEADSET: return "bluetooth";
            default: return "other";
        }
    }

    /**
     * Call audio routing. active=true → Android "communication" mode (call volume, earpiece /
     * speaker / Bluetooth / wired are selectable); active=false → back to normal media audio.
     * speaker=false picks a connected headset first, otherwise the earpiece.
     */
    @PluginMethod
    public void setCallAudio(PluginCall call) {
        final boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        final boolean speaker = Boolean.TRUE.equals(call.getBoolean("speaker", false));
        final boolean auto = Boolean.TRUE.equals(call.getBoolean("auto", false));
        final android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        String route = "speaker";
        boolean hasHeadset = false;
        try {
            if (!active) {
                watchDevices(am, false);
                setProximity(false);
                if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
                am.setSpeakerphoneOn(false);
                am.setMode(android.media.AudioManager.MODE_NORMAL);
                getActivity().runOnUiThread(() -> getActivity().setVolumeControlStream(android.media.AudioManager.STREAM_MUSIC));
            } else {
                am.setMode(android.media.AudioManager.MODE_IN_COMMUNICATION);
                getActivity().runOnUiThread(() -> getActivity().setVolumeControlStream(android.media.AudioManager.STREAM_VOICE_CALL));
                wantSpeaker = speaker;
                if (Build.VERSION.SDK_INT >= 31) {
                    String[] r = applyRoute(am, speaker, auto);
                    route = r[0];
                    hasHeadset = "1".equals(r[1]);
                    watchDevices(am, true);
                } else {
                    am.setSpeakerphoneOn(speaker);
                    route = speaker ? "speaker" : "earpiece";
                }
            }
        } catch (RuntimeException e) {
            call.reject("Audio routing failed: " + e.getMessage());
            return;
        }
        JSObject o = new JSObject();
        o.put("route", active ? route : "speaker");
        o.put("hasHeadset", hasHeadset);
        call.resolve(o);
    }

    /** Output devices Android lets us pick during a call (earpiece, speaker, Bluetooth, wired). */
    // ── automatic headset switching + proximity sensor ──────────────────────────
    private boolean wantSpeaker = false;
    private android.media.AudioDeviceCallback deviceCb;
    private PowerManager.WakeLock proximityLock;

    /** Pick the best output: connected headset (wired/Bluetooth) first, else speaker/earpiece. */
    private String[] applyRoute(android.media.AudioManager am, boolean speaker, boolean auto) {
        android.media.AudioDeviceInfo earpiece = null, spk = null, headset = null;
        for (android.media.AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
            String n = deviceName(d.getType());
            if ("earpiece".equals(n)) earpiece = d;
            else if ("speaker".equals(n)) spk = d;
            else if ("wired".equals(n) || "bluetooth".equals(n)) { if (headset == null || "wired".equals(n)) headset = d; }
        }
        android.media.AudioDeviceInfo pick = (auto && headset != null) ? headset : speaker ? spk : (headset != null ? headset : (earpiece != null ? earpiece : spk));
        String route = "speaker";
        if (pick != null) {
            am.setCommunicationDevice(pick);
            route = deviceName(pick.getType());
        }
        return new String[] {route, headset != null ? "1" : "0"};
    }

    private void pushRoute(String route, boolean hasHeadset) {
        JSObject o = new JSObject();
        o.put("route", route);
        o.put("hasHeadset", hasHeadset);
        notifyListeners("audioRoute", o, true);
    }

    /** While a call is up: a headset that connects takes over; when it leaves we go back to speaker/earpiece. */
    private void watchDevices(final android.media.AudioManager am, boolean on) {
        if (Build.VERSION.SDK_INT < 31) return;
        if (!on) {
            if (deviceCb != null) am.unregisterAudioDeviceCallback(deviceCb);
            deviceCb = null;
            return;
        }
        if (deviceCb != null) return;
        deviceCb = new android.media.AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(android.media.AudioDeviceInfo[] added) {
                for (android.media.AudioDeviceInfo d : added) {
                    String n = deviceName(d.getType());
                    if ("wired".equals(n) || "bluetooth".equals(n)) {
                        try {
                            String[] r = applyRoute(am, false, true); // headset wins over speaker/earpiece
                            pushRoute(r[0], "1".equals(r[1]));
                        } catch (RuntimeException ignored) { }
                        return;
                    }
                }
            }

            @Override
            public void onAudioDevicesRemoved(android.media.AudioDeviceInfo[] removed) {
                for (android.media.AudioDeviceInfo d : removed) {
                    String n = deviceName(d.getType());
                    if ("wired".equals(n) || "bluetooth".equals(n)) {
                        try {
                            String[] r = applyRoute(am, wantSpeaker, false);
                            pushRoute(r[0], "1".equals(r[1]));
                        } catch (RuntimeException ignored) { }
                        return;
                    }
                }
            }
        };
        am.registerAudioDeviceCallback(deviceCb, new android.os.Handler(android.os.Looper.getMainLooper()));
    }

    /** Screen off while the phone is at the ear (earpiece audio calls only). */
    @PluginMethod
    public void setProximity(PluginCall call) {
        setProximity(Boolean.TRUE.equals(call.getBoolean("enabled", false)));
        call.resolve();
    }

    private void setProximity(boolean on) {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (on) {
                if (proximityLock == null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                    proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "meshcall:proximity");
                    proximityLock.setReferenceCounted(false);
                }
                if (proximityLock != null && !proximityLock.isHeld()) proximityLock.acquire(4 * 60 * 60 * 1000L);
            } else if (proximityLock != null && proximityLock.isHeld()) {
                proximityLock.release();
            }
        } catch (RuntimeException ignored) { }
    }

    @PluginMethod
    public void audioOutputs(PluginCall call) {
        android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        String current = "";
        if (Build.VERSION.SDK_INT >= 31) {
            android.media.AudioDeviceInfo cur = am.getCommunicationDevice();
            for (android.media.AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                String n = deviceName(d.getType());
                if ("other".equals(n)) continue;
                JSObject o = new JSObject();
                o.put("id", d.getId());
                o.put("type", n);
                CharSequence pn = d.getProductName();
                o.put("name", "bluetooth".equals(n) && pn != null ? "Bluetooth – " + pn : "earpiece".equals(n) ? "Earpiece" : "speaker".equals(n) ? "Speaker" : "wired".equals(n) ? "Wired headset" : String.valueOf(pn));
                arr.put(o);
                if (cur != null && cur.getId() == d.getId()) current = String.valueOf(d.getId());
            }
        }
        JSObject r = new JSObject();
        r.put("outputs", arr);
        r.put("current", current);
        call.resolve(r);
    }

    @PluginMethod
    public void setAudioOutput(PluginCall call) {
        Integer id = call.getInt("id");
        android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (id == null || Build.VERSION.SDK_INT < 31) {
            call.reject("Not supported");
            return;
        }
        String route = "speaker";
        for (android.media.AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
            if (d.getId() == id) {
                if (!am.setCommunicationDevice(d)) {
                    call.reject("Device unavailable");
                    return;
                }
                route = deviceName(d.getType());
                wantSpeaker = "speaker".equals(route);
            }
        }
        JSObject o = new JSObject();
        o.put("route", route);
        call.resolve(o);
    }

    @PluginMethod
    public void batteryOptimizationIgnored(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject o = new JSObject();
        o.put("ignored", pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(o);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimization(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (RuntimeException e) {
            try {
                getContext().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (RuntimeException ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        JSObject o = new JSObject();
        boolean ok = true;
        if (Build.VERSION.SDK_INT >= 34) {
            ok = getContext().getSystemService(android.app.NotificationManager.class).canUseFullScreenIntent();
        }
        o.put("allowed", ok);
        call.resolve(o);
    }

    @PluginMethod
    public void requestFullScreenIntent(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (RuntimeException ignored) {
            }
        }
        call.resolve();
    }
}
