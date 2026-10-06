# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.kalcode.remote.** {
    *** Companion;
}
-keepclasseswithmembers class com.kalcode.remote.** {
    kotlinx.serialization.KSerializer serializer(...);
}
# The BouncyCastle lightweight X25519 and ChaCha20-Poly1305 classes are used directly.
-keep class org.bouncycastle.math.ec.rfc7748.** { *; }
-keep class org.bouncycastle.crypto.modes.ChaCha20Poly1305 { *; }
-dontwarn org.bouncycastle.**
