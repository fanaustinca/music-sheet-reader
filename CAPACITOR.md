# Adding Capacitor (Android & iOS)

## 1. Install Capacitor
```bash
npm install @capacitor/core @capacitor/cli
npm install @capacitor/android @capacitor/ios
npx cap init "MusicSheet Reader" "com.yourname.musicsheetreader"
```

## 2. Build the app
```bash
ng build
```

## 3. Add platforms
```bash
npx cap add android
npx cap add ios
```

## 4. Sync & open
```bash
npx cap sync
npx cap open android   # Opens Android Studio
npx cap open ios       # Opens Xcode (Mac only)
```

## Notes
- Camera input via `<input type="file" capture="environment">` works natively on mobile
- For a better native camera experience, add `@capacitor/camera` plugin later
- Make sure your Gemini API key is set in `src/environments/environment.ts` before building
