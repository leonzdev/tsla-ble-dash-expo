import { useEffect, useRef } from 'react';
import * as Battery from 'expo-battery';
import { useVehicleStore } from '@state/vehicleStore';

export function PowerStateController() {
  const setAutoRefreshActive = useVehicleStore((state) => state.setAutoRefreshActive);
  const lastChargingState = useRef<boolean | null>(null);

  useEffect(() => {
    let isMounted = true;

    const applyState = (state: Battery.BatteryState | null) => {
      if (!isMounted || state == null) {
        return;
      }
      const isCharging =
        state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
      if (lastChargingState.current === isCharging) {
        return;
      }
      lastChargingState.current = isCharging;
      setAutoRefreshActive(isCharging);
    };

    Battery.getBatteryStateAsync()
      .then(applyState)
      .catch((error) => console.warn('Failed to read initial battery state', error));

    const subscription = Battery.addBatteryStateListener(({ batteryState }) => {
      applyState(batteryState);
    });

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, [setAutoRefreshActive]);

  return null;
}
