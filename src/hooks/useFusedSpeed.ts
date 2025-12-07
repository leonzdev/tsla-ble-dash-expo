import { useEffect, useRef, useState } from 'react';
import { DeviceMotion } from 'expo-sensors';
import { useVehicleStore } from '@state/vehicleStore';
import { FusionEngine, FusionDebugState } from '@lib/fusion/FusionEngine';

/*
 * Hook to consume Fused Speed.
 * Now acts as a subscriber to the Singleton FusionEngine.
 */
export function useFusedSpeed() {
    const [fusedSpeed, setFusedSpeed] = useState<number>(0);
    const [isCalibrated, setIsCalibrated] = useState(false);
    const [debugState, setDebugState] = useState<FusionDebugState | null>(null);

    const lastUpdateRef = useRef<number>(0);

    // Subscribe to Vehicle Store
    const debugEnabled = useVehicleStore((state) => state.fusionDebugEnabled);

    // Subscribe to debugging state
    useEffect(() => {
        if (!debugEnabled) {
            setDebugState(null);
            return;
        }
        const engine = FusionEngine.getInstance();
        const debugTimer = setInterval(() => {
            setDebugState(engine.getDebugState());
        }, 100);
        return () => clearInterval(debugTimer);
    }, [debugEnabled]);

    // Subscribe to Speed Updates
    useEffect(() => {
        const engine = FusionEngine.getInstance();
        const unsubscribeSpeed = engine.subscribe((speed) => {
            // Throttling for UI: 15Hz
            const now = Date.now();
            if (now - lastUpdateRef.current > 66) {
                setFusedSpeed(speed);
                lastUpdateRef.current = now;
            }
        });

        const unsubscribeCalib = engine.subscribeCalibration((calib) => {
            setIsCalibrated(calib);
        });

        return () => {
            unsubscribeSpeed();
            unsubscribeCalib();
        };
    }, []);

    return {
        speed: fusedSpeed,
        isCalibrated,
        rawSpeed: 0, // Placeholder if consumers strictly need it, or remove from interface if possible
        debugState
    };
}

