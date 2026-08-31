package uk.whattowatch.scrobbler

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.service.notification.NotificationListenerService

/** Nudges the system to rebind the listener after the TV reboots. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            NotificationListenerService.requestRebind(
                ComponentName(context, ScrobbleService::class.java)
            )
        }
    }
}
