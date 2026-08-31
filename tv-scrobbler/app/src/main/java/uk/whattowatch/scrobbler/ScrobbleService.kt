package uk.whattowatch.scrobbler

import android.content.ComponentName
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.service.notification.NotificationListenerService
import android.util.Log
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Event-driven "now playing" reporter for the Fire TV. Registered as a
 * notification listener purely to gain MediaSession access; the system keeps
 * the service bound and restarts it if it dies, so nothing polls.
 *
 * Every playback-state or metadata change on any media app fires a callback,
 * which is debounced and pushed to the What To Watch API over HTTPS.
 */
class ScrobbleService : NotificationListenerService() {

    private lateinit var sessionManager: MediaSessionManager
    private val executor = Executors.newSingleThreadExecutor()
    private val watched = mutableMapOf<MediaController, MediaController.Callback>()

    // Last event sent per package, to drop duplicate callbacks.
    private val lastSent = mutableMapOf<String, String>()

    private val sessionListener =
        MediaSessionManager.OnActiveSessionsChangedListener { controllers ->
            attach(controllers ?: emptyList())
        }

    override fun onListenerConnected() {
        Log.i(TAG, "listener connected")
        sessionManager = getSystemService(MediaSessionManager::class.java)
        val me = ComponentName(this, ScrobbleService::class.java)
        try {
            sessionManager.addOnActiveSessionsChangedListener(sessionListener, me)
            attach(sessionManager.getActiveSessions(me))
        } catch (e: SecurityException) {
            Log.e(TAG, "no notification-listener permission yet: run the adb allow_listener command", e)
        }
    }

    override fun onListenerDisconnected() {
        try {
            sessionManager.removeOnActiveSessionsChangedListener(sessionListener)
        } catch (_: Exception) {}
        watched.forEach { (c, cb) -> c.unregisterCallback(cb) }
        watched.clear()
        // Ask the system to rebind us (survives listener hiccups without polling).
        requestRebind(ComponentName(this, ScrobbleService::class.java))
    }

    private fun attach(controllers: List<MediaController>) {
        // Drop callbacks for sessions that vanished.
        val current = controllers.toSet()
        watched.keys.filter { it !in current }.forEach { c ->
            watched.remove(c)?.let { c.unregisterCallback(it) }
        }
        // Watch new sessions.
        for (c in controllers) {
            if (c in watched || c.packageName in IGNORED_APPS) continue
            val cb = object : MediaController.Callback() {
                override fun onPlaybackStateChanged(state: PlaybackState?) = report(c)
                override fun onMetadataChanged(metadata: MediaMetadata?) = report(c)
            }
            c.registerCallback(cb)
            watched[c] = cb
            report(c)
        }
    }

    private fun report(c: MediaController) {
        val state = c.playbackState ?: return
        val stateName = when (state.state) {
            PlaybackState.STATE_PLAYING -> "playing"
            PlaybackState.STATE_PAUSED -> "paused"
            PlaybackState.STATE_STOPPED -> "stopped"
            else -> return
        }
        val md = c.metadata
        val title = md?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
            ?: md?.getString(MediaMetadata.METADATA_KEY_TITLE)
            ?: md?.description?.title?.toString()
        // Apps stash the show name in different fields — try them all.
        val subtitle = md?.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE)
            ?: md?.description?.subtitle?.toString()
            ?: md?.getString(MediaMetadata.METADATA_KEY_ALBUM)
            ?: md?.getString(MediaMetadata.METADATA_KEY_ARTIST)
        val description = (md?.getString(MediaMetadata.METADATA_KEY_DISPLAY_DESCRIPTION)
            ?: md?.description?.description?.toString())?.take(300)
        val durationMs = md?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L

        // Skip exact repeats of what we last sent for this app.
        val fingerprint = "$stateName|$title|$subtitle"
        if (lastSent[c.packageName] == fingerprint) return
        lastSent[c.packageName] = fingerprint

        val body = JSONObject()
            .put("app", c.packageName)
            .put("title", title ?: JSONObject.NULL)
            .put("subtitle", subtitle ?: JSONObject.NULL)
            .put("description", description ?: JSONObject.NULL)
            .put("state", stateName)
            .put("positionMs", state.position)
            .put("durationMs", if (durationMs > 0) durationMs else JSONObject.NULL)
            .toString()

        executor.execute { post(body) }
    }

    private fun post(body: String) {
        try {
            val conn = URL(BuildConfig.ENDPOINT).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer ${BuildConfig.TOKEN}")
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            if (code !in 200..299) Log.w(TAG, "scrobble rejected: HTTP $code")
            else Log.i(TAG, "scrobbled: $body")
            conn.disconnect()
        } catch (e: IOException) {
            // Offline or server down — drop it; the next state change tries again.
            Log.w(TAG, "scrobble failed: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "WtwScrobbler"

        // Music/voice apps and system players we never want in the inbox.
        private val IGNORED_APPS = setOf(
            "com.spotify.tv.android",
            "com.amazon.vizzini",
            "com.amazon.alexamediaplayer.runtime.ftv",
            "com.amazon.tv.launcher",
        )
    }
}
