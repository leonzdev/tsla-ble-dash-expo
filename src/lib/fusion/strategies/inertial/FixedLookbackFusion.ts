import { FusionDebugState } from '../../types';
import { BaseInertialAlgorithm } from './BaseInertialAlgorithm';
import { TimeRealignedFusionAlgorithm } from './TimeRealignedFusion';

/*
 * Algorithm 4: Fixed Lookback Fusion (V4)
 * Uses configurable fixed lookback instead of dynamic latency.
 */
export class FixedLookbackFusionAlgorithm extends TimeRealignedFusionAlgorithm {
    public name = 'Fixed Lookback (V4)';

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        const lookback = this.params.lookbackMs ?? 400;
        const captureTime = arrivalTime - lookback;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: captureTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        const estimatedAtTime = this.getEstimatedSpeedAt(captureTime);
        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        let diff = 0;
        if (estimatedAtTime !== null) {
            diff = bleSpeedMps - estimatedAtTime;
        } else {
            diff = bleSpeedMps - this.currentSpeedMps;
        }

        this.applyFeedback(diff, bleSpeedMps, captureTime);
    }

    getDebugState(): FusionDebugState {
        const base = super.getDebugState();
        return {
            ...base,
            algorithmName: `Fixed Lookback (${this.params.lookbackMs ?? 400}ms)`
        };
    }
}
