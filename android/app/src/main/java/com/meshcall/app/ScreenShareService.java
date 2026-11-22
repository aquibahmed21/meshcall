package com.meshcall.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Screen sharing: MediaProjection → small JPEG frames → the web app (which turns them into a video
 * track). Android WebView has no getDisplayMedia, so this is the bridge. ~6 fps, 540 px wide.
 */
public class ScreenShareService extends Service {
    static final String CH = "screenshare";
    private static final int NOTIF_ID = 1002;
    private static final int TARGET_WIDTH = 540;
    private static final long MIN_FRAME_GAP_MS = 150;

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private long lastFrame = 0;
    private boolean stopping = false;
    static volatile boolean running = false;

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, ScreenShareService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !intent.hasExtra("data")) {
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CH, "Screen sharing", NotificationManager.IMPORTANCE_LOW));
        Notification n = new NotificationCompat.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat_meshcall)
            .setContentTitle("MeshCall – sharing your screen")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(NOTIF_ID, n);

        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            Intent data = intent.getParcelableExtra("data");
            projection = mpm.getMediaProjection(intent.getIntExtra("code", 0), data);
            thread = new HandlerThread("meshcall-screen");
            thread.start();
            final Handler handler = new Handler(thread.getLooper());
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    end();
                }
            }, handler);

            DisplayMetrics dm = new DisplayMetrics();
            ((WindowManager) getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm);
            float scale = (float) TARGET_WIDTH / dm.widthPixels;
            final int w = TARGET_WIDTH & ~1;
            final int h = Math.max(2, Math.round(dm.heightPixels * scale)) & ~1;
            reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
            reader.setOnImageAvailableListener(r -> onFrame(r, w, h), handler);
            display = projection.createVirtualDisplay("meshcall-screen", w, h, dm.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
            running = true;
        } catch (RuntimeException e) {
            end();
        }
        return START_NOT_STICKY;
    }

    private void onFrame(ImageReader r, int w, int h) {
        Image img = null;
        try {
            img = r.acquireLatestImage();
            if (img == null) return;
            long now = System.currentTimeMillis();
            if (now - lastFrame < MIN_FRAME_GAP_MS) return;
            lastFrame = now;
            Image.Plane p = img.getPlanes()[0];
            ByteBuffer buf = p.getBuffer();
            int pixelStride = p.getPixelStride();
            int padded = p.getRowStride() / pixelStride;
            Bitmap bmp = Bitmap.createBitmap(padded, h, Bitmap.Config.ARGB_8888);
            bmp.copyPixelsFromBuffer(buf);
            Bitmap out = padded == w ? bmp : Bitmap.createBitmap(bmp, 0, 0, w, h);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(48 * 1024);
            out.compress(Bitmap.CompressFormat.JPEG, 58, bos);
            if (out != bmp) out.recycle();
            bmp.recycle();
            MeshCallPlugin.emitScreenFrame(Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP), w, h);
        } catch (RuntimeException ignored) {
        } finally {
            if (img != null) img.close();
        }
    }

    private void end() {
        if (stopping) return;
        stopping = true;
        running = false;
        try {
            if (display != null) display.release();
            if (reader != null) reader.close();
            if (projection != null) projection.stop();
        } catch (RuntimeException ignored) {
        }
        if (thread != null) thread.quitSafely();
        MeshCallPlugin.emitScreenEnded();
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        end();
        super.onDestroy();
    }
}
