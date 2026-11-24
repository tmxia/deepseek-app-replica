package io.github.lijiahua1024.dsreplica;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + ASSET_HOST + "/index.html";
    private static final String PROFILE_KEY = "profile";
    private static final int MICROPHONE = 1;
    private static final int FILE_CHOOSER = 2;
    private static final int PHOTOS = 3;
    private static final int CAMERA = 4;
    private static final int EXPORT_HISTORY = 5;
    private static final int WRITE_IMAGES = 7;
    private WebView webView;
    private FrameLayout frame;
    private ApiKeyStore keys;
    private ApiKeyStore chatConfig;
    private final CustomChatTransport customChat = new CustomChatTransport();
    private SharedPreferences profilePreferences;
    private ValueCallback<Uri[]> fileCallback;
    private boolean choosingPhotos;
    private boolean keyboardVisible;
    private volatile float statusInset;
    private volatile float buttonNavigationInset;
    private boolean askedForPhotos;
    private Uri capture;
    private RecentPhotos recentPhotos;
    private FileExport historyExport;
    private ChatStorage chatStorage;
    private final Object storageOwner = new Object();
    private ShadowStore shadow;
    private ImageSave imageSave;
    private NativeRecorder recorder;
    private AppUpdater updater;
    private boolean backPreviewEnabled;
    private final InAppBackCallback inAppBack = new InAppBackCallback(this, this::handleBack,
        this::reportBackPreview);
    private final ExecutorService photoExecutor = Executors.newSingleThreadExecutor();
    private AccessibilityManager accessibility;
    private final AccessibilityManager.AccessibilityStateChangeListener accessibilityState =
        enabled -> {
            if (enabled) primeAccessibility();
        };

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        keys = new ApiKeyStore(this);
        chatConfig = new ApiKeyStore(this, "custom-chat");
        profilePreferences = getSharedPreferences("account_profile", MODE_PRIVATE);
        recentPhotos = new RecentPhotos(getContentResolver());
        historyExport = new FileExport(getContentResolver());
        chatStorage = ChatStorage.get(this);
        shadow = new ShadowStore(this);
        imageSave = new ImageSave(this);
        recorder = new NativeRecorder();
        frame = new FrameLayout(this);
        webView = new WebView(this);
        frame.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        SystemBars.applyInsets(getWindow(), frame, (safe, ime, buttonNavigationBottom) -> {
            // Let WebView paint behind the navigation buttons while CSS insets the controls.
            int webBottom = ime ? 0 : buttonNavigationBottom;
            frame.setPadding(safe.left, 0, safe.right, safe.bottom - webBottom);
            float density = getResources().getDisplayMetrics().density;
            float top = safe.top / density;
            float bottom = webBottom / density;
            if (top != statusInset || bottom != buttonNavigationInset || ime != keyboardVisible) {
                statusInset = top;
                buttonNavigationInset = bottom;
                keyboardVisible = ime;
                webView.evaluateJavascript("if (document.documentElement) { const root = document.documentElement;"
                    + "root.style.setProperty('--android-status-inset', '" + top + "px');"
                    + "root.style.setProperty('--android-button-nav-inset', '" + bottom + "px');"
                    + (bottom > 0 ? "root.setAttribute('data-button-navigation', '');" : "root.removeAttribute('data-button-navigation');")
                    + (ime ? "root.setAttribute('data-keyboard', '');" : "root.removeAttribute('data-keyboard');")
                    + " }", null);
            }
        });
        setContentView(frame);
        accessibility = getSystemService(AccessibilityManager.class);
        if (accessibility != null) {
            accessibility.addAccessibilityStateChangeListener(accessibilityState);
        }
        setBars((getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES);
        WebView.setWebContentsDebuggingEnabled(
            (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new AppPage());
        webView.setWebChromeClient(new DeviceFeatures());
        webView.addJavascriptInterface(new DeviceBridge(), "DeepSeekAndroid");
        updater = new AppUpdater(this, status ->
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-update', {detail: "
                + status + "}))", null));
        webView.loadUrl(HOME);
    }

    private void primeAccessibility() {
        if (webView == null) return;
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        AccessibilityNodeInfo host = webView.createAccessibilityNodeInfo();
        if (host != null) host.recycle();
    }

    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation") // Legacy back still needs to ask the WebView first.
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        webView.evaluateJavascript("window.dispatchEvent(new Event('android-back', {cancelable: true}))",
            result -> { if ("true".equals(result)) finish(); });
    }

    private void reportBackPreview(InAppBackCallback.Preview event) {
        if (!backPreviewEnabled) return;
        String detail = "null";
        if (event != null) {
            float density = getResources().getDisplayMetrics().density;
            String edge = event.edge() == null ? "null" : "'" + event.edge() + "'";
            detail = "{progress: " + event.progress() + ", edge: " + edge
                + ", touchY: " + (event.touchY() / density) + "}";
        }
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-back-preview', {detail: "
            + detail + "}))", null);
    }

    private void setBars(boolean dark) {
        SystemBars.setAppearance(getWindow(), dark);
        int color = Color.parseColor(dark ? "#151517" : "#FFFFFF");
        frame.setBackgroundColor(color);
        webView.setBackgroundColor(color);
    }

    private static boolean isBundled(Uri url) {
        return "https".equals(url.getScheme()) && ASSET_HOST.equals(url.getHost())
            && url.getPort() == -1;
    }

    private static String assetMimeType(String extension) {
        String lower = extension.toLowerCase(java.util.Locale.ROOT);
        return switch (lower) {
            case "html" -> "text/html";
            case "js" -> "text/javascript";
            case "css" -> "text/css";
            case "svg" -> "image/svg+xml";
            case "woff2" -> "font/woff2";
            case "woff" -> "font/woff";
            case "ttf" -> "font/ttf";
            case "png" -> "image/png";
            case "jpg", "jpeg" -> "image/jpeg";
            case "webp" -> "image/webp";
            case "json" -> "application/json";
            default -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(lower);
        };
    }

    private final class AppPage extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            backPreviewEnabled = false;
            inAppBack.setEnabled(false);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (accessibility != null && accessibility.isEnabled()) {
                primeAccessibility();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (isBundled(request.getUrl())) {
                return !request.isForMainFrame() || !"/index.html".equals(request.getUrl().getPath());
            }
            String scheme = request.getUrl().getScheme();
            if (request.isForMainFrame() && ("https".equals(scheme) || "http".equals(scheme))) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (ActivityNotFoundException ignored) {
                    // The device has no browser for external links.
                }
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!isBundled(url)) return null;
            String path = url.getPath();
            if ("GET".equals(request.getMethod()) && path != null && path.startsWith("/chat-attachment/")) {
                try {
                    return new WebResourceResponse("application/octet-stream", null, 200, "OK",
                        Map.of("Cache-Control", "no-store", "X-Content-Type-Options", "nosniff"),
                        chatStorage.openAttachment(path.substring("/chat-attachment/".length())));
                } catch (IOException ignored) {
                    // A missing native file returns the bundled origin's 404.
                }
            }
            if ("/recording.wav".equals(path)) {
                WebResourceResponse audio = recorder.takeWav();
                if (audio != null) return audio;
            }
            if (path != null && path.matches("/(recent|thumbnail)/[0-9]+")) {
                WebResourceResponse photo = recentPhotos.open(url.getLastPathSegment(),
                    path.startsWith("/thumbnail/"));
                if (photo != null) return photo;
            }
            if ("/index.html".equals(path) || (path != null && path.startsWith("/static/")
                    && !path.contains("/../"))) {
                String name = path.substring(1);
                String extension = name.substring(name.lastIndexOf('.') + 1);
                String type = assetMimeType(extension);
                Map<String, String> headers = Map.of("Content-Security-Policy",
                    "default-src 'none'; script-src 'self'; worker-src 'self'; child-src 'self'; "
                    + "style-src 'self' 'unsafe-inline'; "
                    + "img-src 'self' https: data: blob:; font-src 'self' data:; "
                    + "media-src 'self' blob:; connect-src 'self' https://api.deepseek.com; "
                    + "frame-src 'none'; base-uri 'none'; form-action 'none';");
                try {
                    return new WebResourceResponse(type == null ? "application/octet-stream" : type,
                        "UTF-8", 200, "OK", headers, getAssets().open(name));
                } catch (IOException ignored) {
                    // Unknown paths must stay inside the bundled origin.
                }
            }
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                Map.of(), new ByteArrayInputStream(new byte[0]));
        }
    }

    private final class DeviceFeatures extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            choosingPhotos = false;
            if (params.isCaptureEnabled()) {
                if (granted(Manifest.permission.CAMERA)) {
                    launchCamera();
                } else {
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA);
                }
                return true;
            }
            boolean multiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
            if (multiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            String[] mimeTypes = Arrays.stream(params.getAcceptTypes())
                .map(type -> type.startsWith(".")
                    ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.substring(1)) : type)
                .filter(type -> type != null && type.contains("/"))
                .distinct().toArray(String[]::new);
            intent.setType(mimeTypes.length == 1 ? mimeTypes[0] : "*/*");
            if (mimeTypes.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
            choosingPhotos = Arrays.equals(mimeTypes, new String[]{"image/*"});
            if (Build.VERSION.SDK_INT >= 33 && choosingPhotos) {
                Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*");
                if (multiple) {
                    picker.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 10);
                }
                try {
                    startActivityForResult(picker, FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException ignored) {
                    // Use the document picker on devices without the system photo picker.
                }
            }
            try {
                startActivityForResult(intent, FILE_CHOOSER);
            } catch (ActivityNotFoundException ignored) {
                fileCallback = null;
                callback.onReceiveValue(null);
            }
            return true;
        }
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasRecentPhotosPermission() {
        String imagesPermission = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES
            : Manifest.permission.READ_EXTERNAL_STORAGE;
        return granted(imagesPermission) || (Build.VERSION.SDK_INT >= 34
            && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED));
    }

    private void showRecentPhotos() {
        String imagesPermission = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES
            : Manifest.permission.READ_EXTERNAL_STORAGE;
        if (!hasRecentPhotosPermission() && !askedForPhotos) {
            askedForPhotos = true;
            String[] permissions = Build.VERSION.SDK_INT >= 34
                ? new String[]{imagesPermission, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED}
                : new String[]{imagesPermission};
            requestPermissions(permissions, PHOTOS);
        } else {
            notifyRecentPhotos();
        }
    }

    private void notifyRecentPhotos() {
        photoExecutor.execute(() -> {
            String photos = recentPhotos.list();
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed()) {
                    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-photos', "
                        + "{detail: " + photos + "}))", null);
                }
            });
        });
    }

    private void launchCamera() {
        try {
            capture = CaptureProvider.create(this);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, capture)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            camera.setClipData(ClipData.newRawUri("photo", capture));
            startActivityForResult(camera, FILE_CHOOSER);
        } catch (IOException | ActivityNotFoundException ignored) {
            capture = null;
            completeFileChooser(null);
        }
    }

    private void completeFileChooser(Uri[] files) {
        if (fileCallback == null) return;
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        callback.onReceiveValue(files);
    }

    private void completePhotoChooser(Uri[] files) {
        ValueCallback<Uri[]> callback = fileCallback;
        photoExecutor.execute(() -> {
            for (int index = 0; index < files.length; index++) {
                Uri uri = files[index];
                try {
                    if (!SelectedPhoto.isHeif(getContentResolver().getType(uri))) continue;
                    Uri decoded = CaptureProvider.createPng(this);
                    try (OutputStream output = getContentResolver().openOutputStream(decoded)) {
                        if (output == null) continue;
                        SelectedPhoto.writePng(getContentResolver(), uri, output);
                    }
                    files[index] = decoded;
                } catch (IOException | RuntimeException ignored) {
                    // The original document can still be handled by normal attachment validation.
                }
            }
            runOnUiThread(() -> {
                if (!isDestroyed() && fileCallback == callback) completeFileChooser(files);
            });
        });
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == MICROPHONE) {
            startRecording();
        } else if (code == PHOTOS) {
            notifyRecentPhotos();
        } else if (code == CAMERA && fileCallback != null) {
            if (granted(Manifest.permission.CAMERA)) {
                launchCamera();
            } else {
                completeFileChooser(null);
            }
        } else if (code == WRITE_IMAGES) {
            reportImageSavePermission(granted(Manifest.permission.WRITE_EXTERNAL_STORAGE));
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == AppUpdater.INSTALL_SOURCE_SETTINGS) {
            updater.permissionResult();
        } else if (code == EXPORT_HISTORY) {
            Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
            reportExport(uri == null ? "cancelled" : historyExport.open(uri) ? "ready" : "error");
        } else if (code == FILE_CHOOSER && fileCallback != null) {
            Uri[] files = null;
            if (result == RESULT_OK) {
                if (capture != null) {
                    files = new Uri[]{capture};
                } else if (data != null && data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    files = new Uri[clip.getItemCount()];
                    for (int index = 0; index < files.length; index++) {
                        files[index] = clip.getItemAt(index).getUri();
                    }
                } else if (data != null && data.getData() != null) {
                    files = new Uri[]{data.getData()};
                }
            }
            capture = null;
            if (choosingPhotos && files != null) {
                completePhotoChooser(files);
            } else {
                completeFileChooser(files);
            }
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (frame != null) {
            frame.requestApplyInsets();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        updater.resume();
    }

    @Override
    protected void onPause() {
        updater.pause();
        super.onPause();
    }

    @Override
    protected void onStop() {
        recorder.finish(false);
        webView.evaluateJavascript("window.dispatchEvent(new Event('android-recording-interrupted'))", null);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        customChat.close();
        inAppBack.setEnabled(false);
        if (accessibility != null) {
            accessibility.removeAccessibilityStateChangeListener(accessibilityState);
        }
        photoExecutor.shutdownNow();
        updater.close();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        recorder.finish(false);
        historyExport.close();
        chatStorage.disconnect(storageOwner);
        imageSave.finish(false);
        frame.removeView(webView);
        webView.destroy();
        super.onDestroy();
    }

    private void reportExport(String state) {
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-export', "
            + "{detail: '" + state + "'}))", null);
    }

    private void reportImageSavePermission(boolean granted) {
        if (isDestroyed() || webView == null) return;
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-image-save-permission', "
            + "{detail: '" + (granted ? "granted" : "denied") + "'}))", null);
    }

    private void startRecording() {
        String state = !granted(Manifest.permission.RECORD_AUDIO) ? "denied"
            : recorder.start() ? "ready" : "error";
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-recording', "
            + "{detail: '" + state + "'}))", null);
    }

    private final class DeviceBridge {
        @JavascriptInterface
        public float statusInset() { return statusInset; }

        @JavascriptInterface
        public float buttonNavigationInset() { return buttonNavigationInset; }

        @JavascriptInterface
        public float systemFontScale() { return getResources().getConfiguration().fontScale; }

        @JavascriptInterface
        public int getMusicVolume() {
            AudioManager audio = getSystemService(AudioManager.class);
            return audio == null ? -1 : audio.getStreamVolume(AudioManager.STREAM_MUSIC);
        }

        @JavascriptInterface
        public void openAppPermissions() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null))));
        }

        @JavascriptInterface
        public String updateStatus() { return updater.status(); }

        @JavascriptInterface
        public void checkForUpdate() { runOnUiThread(() -> updater.check()); }

        @JavascriptInterface
        public void installUpdate() { runOnUiThread(() -> updater.update()); }

        @JavascriptInterface
        public void openSourcePage(String url, boolean dark, String closeLabel, String browserLabel,
                                   String loadingLabel, String errorLabel, String retryLabel) {
            Uri uri = SourceBrowserActivity.webUri(url);
            if (uri == null) return;
            runOnUiThread(() -> startActivity(new Intent(MainActivity.this, SourceBrowserActivity.class)
                .setData(uri).putExtra("dark", dark)
                .putExtra("closeLabel", closeLabel).putExtra("browserLabel", browserLabel)
                .putExtra("loadingLabel", loadingLabel).putExtra("errorLabel", errorLabel)
                .putExtra("retryLabel", retryLabel)));
        }

        @JavascriptInterface
        public String readApiKey() { return keys.read(); }

        @JavascriptInterface
        public boolean writeApiKey(String value) { return keys.write(value); }

        @JavascriptInterface
        public String readChatConfig() { return chatConfig.read(); }

        @JavascriptInterface
        public boolean writeChatConfig(String value) { return chatConfig.write(value); }

        @JavascriptInterface
        public String beginChatRequest(String endpoint, String format, String body) {
            return customChat.begin(chatConfig.read(), endpoint, format, body, payload ->
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('android-custom-chat',{detail:"
                        + payload + "}))", null);
                }));
        }

        @JavascriptInterface
        public void cancelChatRequest(String id) { if (id != null) customChat.cancel(id); }

        @JavascriptInterface
        public String readAccountProfile() { return profilePreferences.getString(PROFILE_KEY, null); }

        @JavascriptInterface
        public boolean writeAccountProfile(String value) {
            SharedPreferences.Editor editor = profilePreferences.edit();
            if (value == null) editor.remove(PROFILE_KEY);
            else editor.putString(PROFILE_KEY, value);
            return editor.commit();
        }

        @JavascriptInterface
        public void setDarkBars(boolean dark) { runOnUiThread(() -> setBars(dark)); }

        @JavascriptInterface
        public void setHandlesBack(boolean handlesBack) {
            runOnUiThread(() -> { if (!isDestroyed()) inAppBack.setEnabled(handlesBack); });
        }

        @JavascriptInterface
        public void setBackPreviewEnabled(boolean enabled) {
            runOnUiThread(() -> { if (!isDestroyed()) backPreviewEnabled = enabled; });
        }

        @JavascriptInterface
        public void setImageViewerFullscreen(boolean fullscreen) {
            runOnUiThread(() -> SystemBars.setFullscreen(getWindow(), fullscreen));
        }

        @JavascriptInterface
        public void requestRecentPhotos() { runOnUiThread(() -> showRecentPhotos()); }

        @JavascriptInterface
        public void prefetchRecentPhotos() {
            runOnUiThread(() -> { if (hasRecentPhotosPermission()) notifyRecentPhotos(); });
        }

        @JavascriptInterface
        public void requestHistoryExport(String fileName) {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/zip")
                    .putExtra(Intent.EXTRA_TITLE, fileName);
                try {
                    startActivityForResult(intent, EXPORT_HISTORY);
                } catch (ActivityNotFoundException ignored) {
                    reportExport("error");
                }
            });
        }

        @JavascriptInterface
        public boolean writeHistoryExport(String bytes) { return historyExport.append(bytes); }

        @JavascriptInterface
        public boolean finishHistoryExport() { return historyExport.close(); }

        // 聊天数据的原生文件影子镜像：WebView IndexedDB 被系统清空时用于恢复。
        @JavascriptInterface
        public String chatStorage(String method, String json) {
            return chatStorage.request(storageOwner, method, json);
        }

        @JavascriptInterface
        public String shadowList(String dir) { return shadow.list(dir); }

        @JavascriptInterface
        public String shadowReadChunk(String path, long offset) {
            return shadow.readChunk(path, offset);
        }

        @JavascriptInterface
        public boolean shadowClearAll() { return shadow.clearAll(); }

        @JavascriptInterface
        public void requestImageSavePermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        || granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
                    reportImageSavePermission(true);
                } else {
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, WRITE_IMAGES);
                }
            });
        }

        @JavascriptInterface
        public boolean beginImageSave(String name, String mime) { return imageSave.begin(name, mime); }

        @JavascriptInterface
        public boolean writeImageSave(String bytes) { return imageSave.append(bytes); }

        @JavascriptInterface
        public boolean finishImageSave(boolean keep) { return imageSave.finish(keep); }

        @JavascriptInterface
        public void requestRecording() {
            runOnUiThread(() -> {
                if (granted(Manifest.permission.RECORD_AUDIO)) {
                    startRecording();
                } else {
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE);
                }
            });
        }

        @JavascriptInterface
        public boolean finishRecording(boolean keep) { return recorder.finish(keep); }

        @JavascriptInterface
        public double recordingLevel() { return recorder.level(); }

        @JavascriptInterface
        public void setSelectionExclusion(
            float startLeft,
            float startTop,
            float startRight,
            float startBottom,
            float endLeft,
            float endTop,
            float endRight,
            float endBottom,
            boolean active
        ) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
            runOnUiThread(() -> {
                if (webView == null) return;
                if (!active) {
                    webView.setSystemGestureExclusionRects(Collections.emptyList());
                    return;
                }
                float density = getResources().getDisplayMetrics().density;
                List<Rect> rects = new ArrayList<>(2);
                int w = webView.getWidth();
                int h = webView.getHeight();
                if (startRight > startLeft && startBottom > startTop) {
                    rects.add(new Rect(
                        Math.max(0, Math.round(startLeft * density)),
                        Math.max(0, Math.round(startTop * density)),
                        Math.min(w, Math.round(startRight * density)),
                        Math.min(h, Math.round(startBottom * density))
                    ));
                }
                if (endRight > endLeft && endBottom > endTop) {
                    rects.add(new Rect(
                        Math.max(0, Math.round(endLeft * density)),
                        Math.max(0, Math.round(endTop * density)),
                        Math.min(w, Math.round(endRight * density)),
                        Math.min(h, Math.round(endBottom * density))
                    ));
                }
                webView.setSystemGestureExclusionRects(rects);
            });
        }
    }
}
