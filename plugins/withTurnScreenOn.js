const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withTurnScreenOn(config) {
  return withAndroidManifest(config, (cfg) => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    mainActivity.$['android:showWhenLocked'] = 'true';
    mainActivity.$['android:turnScreenOn'] = 'true';
    return cfg;
  });
};
