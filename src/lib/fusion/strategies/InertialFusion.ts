import { BaseInertialAlgorithm } from '../BaseInertialAlgorithm';

/*
 * Algorithm 1: Inertial Fusion (V1)
 * Basic sensor fusion without latency compensation.
 */
export class InertialFusionAlgorithm extends BaseInertialAlgorithm {
    public name = 'Sensor Fusion V1';

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: arrivalTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        const bleSpeedMps = rawSpeed * this.speedConversionFactor;
        const diff = bleSpeedMps - this.currentSpeedMps;

        // V1 uses 'arrivalTime' as capture time (no latency comp)
        this.applyFeedback(diff, bleSpeedMps, arrivalTime);
    }
}
