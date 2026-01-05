import { Vector3, FusionDebugState, FusionAlgorithm } from '../../types';

/*
 * Passthrough Algorithm
 * BLE-only, no sensor fusion. Simply passes through raw BLE speed.
 */
export class PassthroughAlgorithm implements FusionAlgorithm {
    public name = 'Passthrough (BLE Only)';
    private lastSpeed: number = 0;

    reset() { }
    setParams(params: any) { }
    setGear(gear: string | null) { }

    pushMotion(accel: Vector3, timestamp: number) { }

    pushBle(speed: number, arrivalTime: number, latencyMs: number) {
        this.lastSpeed = speed;
    }

    update(dt: number): number {
        return this.lastSpeed;
    }

    getDebugState(): FusionDebugState {
        return {
            algorithmName: this.name,
            bleSpeed: this.lastSpeed,
            fusedSpeed: this.lastSpeed,
            isCalibrated: true,
            conversionFactor: 1.0,
            accelerationMps2: 0
        };
    }
}
