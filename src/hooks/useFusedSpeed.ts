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
    const driveState = useVehicleStore((state) => state.driveState);
    const activeAlgo = useVehicleStore(state => state.currentFusionAlgo);
    const algoParams = useVehicleStore(state => state.fusionAlgoParams);
    const latencyMs = useVehicleStore((state) => state.lastLatencyMs);
    const debugEnabled = useVehicleStore((state) => state.fusionDebugEnabled);
    const slopeCorrectionEnabled = useVehicleStore((state) => state.slopeCorrectionEnabled);
    const driveData = driveState?.vehicleData?.driveState ?? driveState?.vehicleData?.drive_state ?? null;
    const rawSpeed = parseVehicleSpeed(driveData);

    useEffect(() => {
        // Shared Engine
        const engine = FusionEngine.getInstance();

        // Ensure we are feeding sensor data
        // We only need one active feeder for the app.
        // However, since we are moving to components, let's keep the feeder here for now?
        // Optimization: Only the "Primary" hook should feed? 
        // Or just let the engine handle it.
        // Let's implement the simpler approach: The hook subscribes. 
        // AND the hook manages the sensor connection if it's the "Main" one?
        // To solve the multiple-listener issue:
        // We will move DeviceMotion INSIDE FusionEngine (via public method or internally).
        // For now, let's allow this hook to be the "Driver".

        // Note: We are refactoring to isolate components. The components WON'T use this hook.
        // This hook will effectively be deprecated or used only by the invisible "Controller" component.

        // Let's assume we place a <FusionController /> or similar in the layout.
        // OR we just leave this hook running in DashboardScreen (which we wanted to avoid re-rendering).

        // WAIT. If DashboardScreen uses this hook, it re-renders.
        // So DashboardScreen CANNOT use this hook.

        // New Plan:
        // 1. DashboardScreen renders <SpeedReadout />.
        // 2. <SpeedReadout /> uses this hook.
        // 3. This hook subscribes to Engine.
        // 4. Engine updates.
        // 5. <SpeedReadout /> re-renders (15Hz).
        // 6. DashboardScreen (parent) DOES NOT re-render.

        // So this hook implementation is fine. We just need to stop using it in the Parent.

        // But who feeds the sensors?
        // If <SpeedReadout> feeds sensors, it works when component is mounted.
        // Ensure permissions
        DeviceMotion.requestPermissionsAsync().then(({ status }) => {
            if (status !== 'granted') {
                console.warn('Sensor permissions denied');
            }
        });

        DeviceMotion.setUpdateInterval(20);
        const subscription = DeviceMotion.addListener((event) => {
            if (event.acceleration) {
                engine.handleMotionUpdate(event.acceleration);
            }
        });

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
            subscription.remove();
            unsubscribeSpeed();
            unsubscribeCalib();
        };
    }, []);

    // Debug Loop
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

    // Sync Algo
    useEffect(() => {
        const params = algoParams[activeAlgo];
        FusionEngine.getInstance().setAlgorithm(activeAlgo, {
            ...params,
            slopeCorrectionEnabled: slopeCorrectionEnabled
        });
    }, [activeAlgo, algoParams, slopeCorrectionEnabled]);

    // Feed BLE
    useEffect(() => {
        if (rawSpeed != null) {
            FusionEngine.getInstance().addBleMeasurement(rawSpeed, latencyMs ?? 0);
        }
    }, [rawSpeed, latencyMs]);

    return {
        speed: fusedSpeed,
        isCalibrated,
        rawSpeed,
        debugState
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
