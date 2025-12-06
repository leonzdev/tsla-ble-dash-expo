import { useEffect, useRef, useState } from 'react';
import { DeviceMotion } from 'expo-sensors';
import { useVehicleStore } from '@state/vehicleStore';
import { FusionEngine } from '@lib/fusion/FusionEngine';

export function useFusedSpeed() {
    const [fusedSpeed, setFusedSpeed] = useState<number>(0);
    const [isCalibrated, setIsCalibrated] = useState(false);
    const engineRef = useRef<FusionEngine | null>(null);

    // Subscribe to Vehicle Store
    const driveState = useVehicleStore((state) => state.driveState);
    const driveData = driveState?.vehicleData?.driveState ?? driveState?.vehicleData?.drive_state ?? null;
    const rawSpeed = parseVehicleSpeed(driveData);

    useEffect(() => {
        // effective update rate 50Hz
        DeviceMotion.setUpdateInterval(20);

        const engine = new FusionEngine(
            (speed) => setFusedSpeed(speed),
            (calibrated) => setIsCalibrated(calibrated)
        );
        engine.start();
        engineRef.current = engine;

        const subscription = DeviceMotion.addListener((event) => {
            if (event.acceleration) {
                // DeviceMotion.acceleration gives acceleration WITHOUT gravity
                // units are m/s^2
                engine.handleMotionUpdate(event.acceleration);
            }
        });

        return () => {
            subscription.remove();
            engine.stop();
        };
    }, []);

    // Feed BLE updates to engine
    useEffect(() => {
        if (engineRef.current && rawSpeed != null) {
            engineRef.current.addBleMeasurement(rawSpeed);
        }
    }, [rawSpeed]);

    return {
        speed: fusedSpeed,
        isCalibrated,
        rawSpeed // Expose raw for debugging/comparison
    };
}

function parseVehicleSpeed(driveState: any): number | null {
    if (!driveState || typeof driveState !== 'object') {
        return null;
    }
    const candidates = [
        driveState.speedFloat,
        driveState.speed_float,
        driveState.speed,
        driveState.optionalSpeedFloat,
        driveState.optional_speed_float,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate;
        }
    }
    return null;
}
