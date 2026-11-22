package dev.remagnet.app.data

import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * The small slice of storage this app needs. Keeping it behind an interface
 * lets the settings repository run in plain JVM tests without Robolectric.
 */
interface KeyValueStore {
    fun getString(key: String): String?

    fun putString(key: String, value: String?)
}

class SharedPreferencesStore(
    private val preferences: SharedPreferences,
) : KeyValueStore {
    override fun getString(key: String): String? = preferences.getString(key, null)

    override fun putString(key: String, value: String?) {
        preferences.edit {
            if (value == null) remove(key) else putString(key, value)
        }
    }
}
