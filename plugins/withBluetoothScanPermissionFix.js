const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

const BLUETOOTH_SCAN_PERMISSION = 'android.permission.BLUETOOTH_SCAN';

module.exports = function withBluetoothScanPermissionFix(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    AndroidConfig.Manifest.ensureToolsAvailable(cfg.modResults);

    manifest['uses-permission'] = manifest['uses-permission'] ?? [];
    const exists = manifest['uses-permission'].some(
      (entry) => entry.$['android:name'] === BLUETOOTH_SCAN_PERMISSION && entry.$['tools:remove'] === 'android:usesPermissionFlags',
    );
    if (!exists) {
      manifest['uses-permission'].push({
        $: {
          'android:name': BLUETOOTH_SCAN_PERMISSION,
          'tools:remove': 'android:usesPermissionFlags',
        },
      });
    }
    return cfg;
  });
};
