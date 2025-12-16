export interface Vector3 {
    x: number;
    y: number;
    z: number;
}

export interface FusionDebugState {
    bleSpeed: number;
    fusedSpeed: number;
    algorithmName: string;
    isCalibrated: boolean;
    conversionFactor: number;
    accelerationMps2?: number;
}

export type SpeedUpdateCallback = (speed: number) => void;
export type CalibrationCallback = (isCalibrated: boolean) => void;

/*
 * Strategy Interface
 */
export interface FusionAlgorithm {
    name: string;
    reset(): void;
    setParams(params: any): void;
    setGear(gear: string | null): void;
    pushMotion(accel: Vector3, timestamp: number): void;
    pushBle(speed: number, arrivalTime: number, latencyMs: number): void;
    update(dt: number): number;
    getDebugState(): FusionDebugState;
}

// Shared Constants
export const MIN_CALIBRATION_SPEED = 5;
export const MIN_SENSOR_ACCEL = 0.5;
export const FILTER_GAIN_BLE = 0.15;
export const SPEED_DECAY = 0.9995;
export const PROPORTIONAL_GAIN = 0.15;
export const SENSOR_SYNC_SLOP = 200;
