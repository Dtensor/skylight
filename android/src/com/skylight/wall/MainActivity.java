package com.skylight.wall;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The Sky Window as an app: one fullscreen WebView and nothing else. No bars,
 * no address line, the screen kept awake, and sound allowed to start by itself.
 * The page address arrives as the "url" extra and is remembered for next time.
 */
public class MainActivity extends Activity {
    private WebView web;
    private String url;
    private final Handler handler = new Handler();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) retry();
            }
        });
        setContentView(web);
        open(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        open(intent);
    }

    private void open(Intent intent) {
        SharedPreferences prefs = getSharedPreferences("wall", MODE_PRIVATE);
        String given = intent == null ? null : intent.getStringExtra("url");
        if (given != null && (given.startsWith("http://") || given.startsWith("https://"))) {
            prefs.edit().putString("url", given).apply();
        }
        url = prefs.getString("url", null);
        if (url == null) {
            web.loadData("<body style='background:#000;color:#9aa6bd;font:28px sans-serif;padding:8%'>"
                + "Sky Window has no address yet. Start it from the Mac with wall-on.py.</body>", "text/html", "utf-8");
        } else {
            web.loadUrl(url);
        }
    }

    /** The server may be asleep or restarting: keep the wall dark and try again. */
    private void retry() {
        web.loadData("<body style='background:#000'></body>", "text/html", "utf-8");
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (url != null) web.loadUrl(url);
            }
        }, 8000);
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        immersive();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
