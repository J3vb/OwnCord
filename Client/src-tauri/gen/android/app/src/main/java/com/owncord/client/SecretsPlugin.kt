package com.owncord.client

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

@InvokeArg
class SecretArgs {
  var account: String = ""
  var secret: String? = null
}

// The app's secret store: one AES-256 key in the Android Keystore, and each
// value sealed under it (SecretSeal) in a private preferences file. Only the
// Rust `secret_store` calls it, from a background thread; the commands run on
// the main thread one at a time, so key creation cannot race.
@TauriPlugin
class SecretsPlugin(activity: Activity) : Plugin(activity) {
  private val prefs =
    activity.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Command
  fun secretSet(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecretArgs::class.java)
      val secret = args.secret
      if (args.account.isEmpty() || secret == null) {
        invoke.reject("account and secret are required")
        return
      }
      val sealed = SecretSeal.seal(existingKey() ?: createKey(), args.account, secret)
      if (prefs.edit().putString(args.account, sealed).commit()) {
        invoke.resolve()
      } else {
        invoke.reject("secret was not saved")
      }
    } catch (error: Exception) {
      invoke.reject("secret was not saved", error)
    }
  }

  @Command
  fun secretGet(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecretArgs::class.java)
      val stored = prefs.getString(args.account, null)
      if (stored == null) {
        invoke.resolve(JSObject())
        return
      }
      // A stored value without its key is unreadable, never "nothing stored".
      val key = existingKey()
      if (key == null) {
        invoke.reject("the key for a stored secret is missing")
        return
      }
      invoke.resolve(JSObject().apply { put("value", SecretSeal.open(key, args.account, stored)) })
    } catch (error: Exception) {
      invoke.reject("secret did not open", error)
    }
  }

  @Command
  fun secretDelete(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecretArgs::class.java)
      if (!prefs.contains(args.account) || prefs.edit().remove(args.account).commit()) {
        invoke.resolve()
      } else {
        invoke.reject("secret was not removed")
      }
    } catch (error: Exception) {
      invoke.reject("secret was not removed", error)
    }
  }

  private fun existingKey(): SecretKey? {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    return (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
  }

  private fun createKey(): SecretKey {
    val spec = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
      .apply { init(spec) }
      .generateKey()
  }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "owncord-secrets"
    const val PREFS = "owncord_secrets"
  }
}
