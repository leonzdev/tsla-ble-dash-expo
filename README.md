# tsla-ble-dash-expo

An Expo-powered native port of [tsla-ble-dash](https://github.com/leonzdev/tsla-ble-dash), focused on delivering the dashboard and debug tooling as a dedicated Android/iOS experience.

## Features

- 📟 Dashboard view that mirrors the web PWA, showing speed, gear, and key status with a touch-friendly layout toggle.
- 🧰 Debug screen with VIN selection, BLE discovery mode control, profile management, and Tesla BLE session controls.
- 🔑 Local profile storage (AsyncStorage) for private/public keys with secure generation via the app.
- 🚗 BLE transport built on top of `react-native-ble-plx`, using Expo config plugins for the required permissions.
- ♻️ Auto-refresh loop for vehicle state polling, synchronized with the dashboard controls.

## Getting started

```bash
npm install
npm run android   # or npm run ios/npm run web
```

Because this project uses native BLE APIs and custom config plugins, you need to build a development client (`expo run:android` / `expo run:ios`) or create an EAS development build. Expo Go cannot run the app.

## Project structure

- `src/lib` – BLE transport, crypto helpers, protocol definitions, and session logic ported from the web app.
- `src/screens` – Dashboard and Debug screens.
- `src/state` – Shared Zustand store used to synchronize dashboard/debug state.
- `src/components` – Reusable UI primitives (buttons, etc.).

## Notes

- A Tesla VIN is required to scan for BLE beacons—Bluetooth scanning uses the VIN beacon prefix for filtering/validation depending on the selected discovery mode.
- The crypto primitives are implemented with the `@noble/*` family plus Expo's crypto utilities so they work on both Android and iOS without custom native code.
- Auto-refresh uses the same logic as the PWA; intervals are persisted and can be toggled from either screen.
