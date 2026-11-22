package com.meshcall.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;

/**
 * Runs MeshCall's web app (signaling + presence only, no UI) inside the foreground service while
 * the Activity does not exist – e.g. after "Close all" in Recents. It shares the Activity's
 * https://localhost storage, so it has the same identity and room, and it shows incoming calls and
 * messages as native notifications. It is destroyed the moment the Activity starts again, so
 * there is never more than one live connection for this device.
 */
final class HeadlessHost {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static WebView view;
    private static Context appContext;

    private HeadlessHost() {}

    static boolean isRunning() {
        return view != null;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    static void start(Context ctx) {
        appContext = ctx.getApplicationContext();
        MAIN.post(() -> {
            if (view != null) return;
            try {
                final WebViewAssetLoader.PathHandler assets = path -> {
                    String p = path.isEmpty() || path.endsWith("/") ? path + "index.html" : path;
                    try {
                        InputStream in = appContext.getAssets().open("public/" + p);
                        String mime = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css" : p.endsWith(".html") ? "text/html" : p.endsWith(".json") || p.endsWith(".webmanifest") ? "application/json" : p.endsWith(".svg") ? "image/svg+xml" : p.endsWith(".png") ? "image/png" : "application/octet-stream";
                        return new WebResourceResponse(mime, "utf-8", in);
                    } catch (IOException e) {
                        return null;
                    }
                };
                final WebViewAssetLoader loader = new WebViewAssetLoader.Builder().setDomain("localhost").addPathHandler("/", assets).build();
                WebView w = new WebView(appContext);
                WebSettings s = w.getSettings();
                s.setJavaScriptEnabled(true);
                s.setDomStorageEnabled(true);
                s.setMediaPlaybackRequiresUserGesture(false);
                w.addJavascriptInterface(new Bridge(), "MeshCallHeadless");
                w.setWebViewClient(new WebViewClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                        return loader.shouldInterceptRequest(r.getUrl());
                    }
                });
                view = w;
                w.onResume();
                w.resumeTimers();
                w.dispatchWindowVisibilityChanged(View.VISIBLE);
                w.loadUrl("https://localhost/index.html");
                MAIN.postDelayed(keepAwake, 2000);
            } catch (RuntimeException e) {
                view = null;
            }
        });
    }

    private static final Runnable keepAwake = new Runnable() {
        @Override
        public void run() {
            if (view == null) return;
            view.resumeTimers();
            view.dispatchWindowVisibilityChanged(View.VISIBLE);
            MAIN.postDelayed(this, 2000);
        }
    };

    static void stop() {
        MAIN.post(() -> {
            MAIN.removeCallbacks(keepAwake);
            WebView w = view;
            view = null;
            if (w == null) return;
            try {
                w.loadUrl("about:blank");
                w.removeJavascriptInterface("MeshCallHeadless");
                w.destroy();
            } catch (RuntimeException ignored) {
            }
        });
    }

    /** Decline tapped on a notification while only the headless app is running. */
    static boolean deliver(String tag, String action, String data) {
        final WebView w = view;
        if (w == null) return false;
        final String js = "window.__meshcallAction&&window.__meshcallAction(" + org.json.JSONObject.quote(tag) + "," + org.json.JSONObject.quote(action) + "," + org.json.JSONObject.quote(data == null ? "{}" : data) + ")";
        MAIN.post(() -> w.evaluateJavascript(js, null));
        return true;
    }

    static void deliverExternal(boolean on) {
        final WebView w = view;
        if (w == null) return;
        MAIN.post(() -> w.evaluateJavascript("window.__meshcallExternal&&window.__meshcallExternal(" + on + ")", null));
    }

    /** What the headless web app can call. */
    static final class Bridge {
        @JavascriptInterface
        public void show(String tag, String title, String body, String kind, String data, long timeoutMs) {
            NotificationHelper.show(appContext, tag, title, body, kind, data, timeoutMs);
        }

        @JavascriptInterface
        public void cancel(String tag) {
            NotificationHelper.cancel(appContext, tag);
        }
    }
}
