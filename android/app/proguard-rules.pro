# Keep kotlinx-serialization generated serializers (release builds only; minify is off by default).
-keepclasseswithmembers class **.*$serializer { *; }
-keepclassmembers class **.* { *** serializer(); }
-dontwarn org.slf4j.**
