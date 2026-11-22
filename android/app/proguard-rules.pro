# R8 rules for the release build.
#
# Gson reads field names at runtime, so classes and fields that are not
# annotated with @SerializedName must survive shrinking and obfuscation. The
# generated proxy models carry @SerializedName on every field; the qBittorrent
# DTO uses the API's own field names and has no annotations.

# Gson needs annotations and the generic signatures on its model classes.
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keepattributes AnnotationDefault

# Keep annotated fields under their serialized names, in any class.
-keepclassmembers,allowobfuscation class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

# The qBittorrent response object is deserialized by field name.
-keepclassmembers class dev.remagnet.app.client.QBittorrentClient$TorrentDto {
    <fields>;
}

# The generated Retrofit models are small and reflection-driven.
-keep class dev.remagnet.proxy.models.** { *; }

# Retrofit creates the service implementations with a dynamic proxy, so R8
# cannot see which methods are called. Keep the generated interfaces and
# suspend continuations intact; without this, creating the archive service
# throws a ClassCastException in release builds.
-if interface * { @retrofit2.http.* <methods>; }
-keep,allowobfuscation interface <1>
-keep interface dev.remagnet.proxy.apis.** { *; }
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
