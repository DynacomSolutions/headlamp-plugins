# kotlinx.serialization: keep generated serialisers and companions of our models.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class app.headlamps.** {
    *** Companion;
}
-keepclasseswithmembers class app.headlamps.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class app.headlamps.**$$serializer { *; }
-keepclassmembers class app.headlamps.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp optional TLS providers are not on Android.
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
