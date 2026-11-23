# 📦 تطبيق جرد المخزون الاحترافي (GitHub + Android Studio)

## أهم الإصلاحات في هذه النسخة:
- إضافة أيقونات التطبيق الحقيقية (`icon-192.png` و `icon-512.png`) حتى لا يظهر أي نقص في ملفات الـ PWA أو الأندرويد.
- إصلاح أمر `prepare-web` ليعمل على ويندوز ولينكس بدون مشاكل.
- دعم تصدير ومشاركة ملفات Excel و JSON داخل تطبيق الأندرويد APK عبر `@capacitor/filesystem` و `@capacitor/share`.
- تضمين ملف `.gitignore` وملف البناء التلقائي `.github/workflows/build-apk.yml`.
