import { FusionDebugState } from '../types';
import { BaseInertialAlgorithm } from '../BaseInertialAlgorithm';

/*
 * Algorithm 2: Time-Realigned Fusion (V2)
 * Compensates for BLE latency by backdating speed samples.
 */
export class TimeRealignedFusionAlgorithm extends BaseInertialAlgorithm {
    public name = 'Time-Realigned Fusion (V2)';

    protected outputHistory: { speedMps: number; time: number }[] = [];

    protected onReset() {
        super.onReset();
        this.outputHistory = [];
    }

    protected onPostUpdate(dt: number) {
        this.recordHistory(this.currentSpeedMps, Date.now());
    }

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        const captureTime = arrivalTime - latencyMs;

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

    protected recordHistory(speedMps: number, time: number) {
        this.outputHistory.push({ speedMps, time });
        const cutoff = time - 2000;
        while (this.outputHistory.length > 0 && this.outputHistory[0].time < cutoff) {
            this.outputHistory.shift();
        }
    }

    protected getEstimatedSpeedAt(time: number): number | null {
        if (this.outputHistory.length === 0) return null;
        let closest = this.outputHistory[0];
        let minDiff = Math.abs(closest.time - time);

        for (let i = 1; i < this.outputHistory.length; i++) {
            const item = this.outputHistory[i];
            const diff = Math.abs(item.time - time);
            if (diff < minDiff) {
                minDiff = diff;
                closest = item;
            }
        }
        if (minDiff > 500) return null;
        return closest.speedMps;
    }
}
