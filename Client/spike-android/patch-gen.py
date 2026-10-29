import pathlib, shutil, sys
here = pathlib.Path(__file__).parent
app = here.parent / "src-tauri/gen/android/app/src/main"
m = app / "AndroidManifest.xml"
s = m.read_text()
perms = "".join(f'    <uses-permission android:name="android.permission.{p}" />\n' for p in [
    "RECORD_AUDIO", "CAMERA", "MODIFY_AUDIO_SETTINGS", "BLUETOOTH_CONNECT", "WAKE_LOCK",
    "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_MICROPHONE", "POST_NOTIFICATIONS"])
s = s.replace("<application", perms + "    <application", 1)
s = s.replace("</application>", '        <service android:name=".SpikeCallService" android:exported="false" android:foregroundServiceType="microphone" />\n    </application>', 1)
m.write_text(s)
kt = next(app.glob("java/**/MainActivity.kt"))
print("MainActivity at", kt, "\n--- generated ---\n", kt.read_text())
for f in ["MainActivity.kt", "SpikeBridge.kt", "SpikeCallService.kt"]:
    shutil.copy(here / f, kt.parent / f)
(app / "assets").mkdir(exist_ok=True)
shutil.copy(here / "spike-panel.js", app / "assets/spike-panel.js")
print(m.read_text())
