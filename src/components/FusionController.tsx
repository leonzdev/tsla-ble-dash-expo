import { useEffect, useRef } from 'react';
import { useVehicleStore } from '@state/vehicleStore';
import { FusionEngine } from '@lib/fusion/FusionEngine';

/*
 * FusionController
 * 
 * Invisible component responsible for:
 * 1. Feeding BLE measurements to the Engine.
 * 2. Syncing Algorithm Parameters from Store to Engine.
 * 
 * Should be mounted EXACTLY ONCE in the app hierarchy (e.g. DashboardScreen).
 */
export function FusionController() {
    // BLE Data
    const driveState = useVehicleStore((state) => state.driveState);
    const latencyMs = useVehicleStore((state) => state.lastLatencyMs);
    const driveData = driveState?.vehicleData?.driveState ?? driveState?.vehicleData?.drive_state ?? null;
    const rawSpeed = parseVehicleSpeed(driveData);

    // Config
    const activeAlgo = useVehicleStore(state => state.currentFusionAlgo);
    const algoParams = useVehicleStore(state => state.fusionAlgoParams);
    const slopeCorrectionEnabled = useVehicleStore((state) => state.slopeCorrectionEnabled);

    // Sync Algo Params
    useEffect(() => {
        const params = algoParams[activeAlgo] || {};
        FusionEngine.getInstance().setAlgorithm(activeAlgo, {
            ...params,
            slopeCorrectionEnabled
        });
    }, [activeAlgo, algoParams, slopeCorrectionEnabled]);

    // Feed BLE Measurements
    useEffect(() => {
        if (rawSpeed !== null) {
            FusionEngine.getInstance().addBleMeasurement(rawSpeed, latencyMs ?? 0);
        }
    }, [rawSpeed, latencyMs]);

    return null;
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
