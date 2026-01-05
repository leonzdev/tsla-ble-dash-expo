import { Vector3 } from '../../types';
import { BaseInertialAlgorithm } from './BaseInertialAlgorithm';
import { TimeRealignedFusionAlgorithm } from './TimeRealignedFusion';

/*
 * Algorithm 3: Median Latency Fusion (V3)
 * Uses median of recent latencies for more stable compensation.
 */
export class MedianLatencyFusionAlgorithm extends TimeRealignedFusionAlgorithm {
    public name = 'Median Latency Fusion (V3)';

    protected latencyHistory: number[] = [];

    protected onReset() {
        super.onReset();
        this.latencyHistory = [];
    }

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        this.latencyHistory.push(latencyMs);
        if (this.latencyHistory.length > 10) {
            this.latencyHistory.shift();
        }

        const sorted = [...this.latencyHistory].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianLatency = sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;

        const captureTime = arrivalTime - medianLatency;

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
}
