# WTW Scrobbler (Fire TV app)

A tiny background app for the Fire TV that reports what's playing to
whattowatch.uk. **Event-driven, not polling**: it registers a
`MediaSessionManager` listener (via notification-listener permission) and the
system pushes it a callback whenever any app starts, pauses, or changes what
it's playing. The system keeps the service alive and rebinds it after reboots.

It has no UI and no launcher icon. It ignores music/voice apps (Spotify,
Alexa) and sends only: package name, title, play/pause/stop, and position.

## Build

1. Edit `gradle.properties` — set `wtw.token` to the same random string you
   set as the `DEVICE_TOKEN` secret on the Cloudflare Pages project.
2. Open this `tv-scrobbler` folder in Android Studio (same setup that built
   the Universal Remote app — AGP 8.5.2 / Kotlin 1.9.24) and run
   **Build → Build APK**, or from a terminal: `gradle assembleDebug`.
   The APK lands in `app/build/outputs/apk/debug/`.

## Install on the TV

Using the adb.exe already in `Desktop\TV Adblock\platform-tools`:

```bat
adb connect 192.168.0.42:5555
adb -s 192.168.0.42:5555 install -r app-debug.apk
adb -s 192.168.0.42:5555 shell cmd notification allow_listener uk.whattowatch.scrobbler/.ScrobbleService
```

That last command grants the media-session access (one-off; survives reboots).

## Verify

Play something on the TV, then:

```bat
adb -s 192.168.0.42:5555 logcat -d -s WtwScrobbler
```

You should see `scrobbled: {...}` lines, and the item appears in the
**TV activity** inbox on whattowatch.uk within seconds.

## Notes

- Metadata quality varies by app: NOW sends episode titles, the Apple TV app
  sends nothing (those show as "Unknown title" in the inbox).
- To update the endpoint/token, rebuild and `install -r` again.
- To remove: `adb -s 192.168.0.42:5555 uninstall uk.whattowatch.scrobbler`
