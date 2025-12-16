// Re-export types for external consumers
export {
    Vector3,
    FusionDebugState,
    FusionAlgorithm,
    SpeedUpdateCallback,
    CalibrationCallback,
} from './types';

import { FusionAlgorithm, SpeedUpdateCallback, CalibrationCallback, Vector3 } from './types';
import {
    InertialFusionAlgorithm,
    TimeRealignedFusionAlgorithm,
    MedianLatencyFusionAlgorithm,
    FixedLookbackFusionAlgorithm,
    PassthroughAlgorithm,
    CalibrationFusionAlgorithm,
} from './strategies';

import { DeviceMotion } from 'expo-sensors';

/*
 * Engine Manager (Singleton)
 */
export class FusionEngine {
    private static instance: FusionEngine;
    private algorithm: FusionAlgorithm;
    private speedListeners: Set<SpeedUpdateCallback> = new Set();
    private calibrationListeners: Set<CalibrationCallback> = new Set();
    private timer: NodeJS.Timeout | null = null;
    private lastUpdateTime: number = 0;
    private motionSubscription: any = null; // Subscription type
    private lastGear: string | null = null;

    private constructor() {
        this.algorithm = new InertialFusionAlgorithm();
        DeviceMotion.setUpdateInterval(20);
    }

    public static getInstance(): FusionEngine {
        if (!FusionEngine.instance) {
            FusionEngine.instance = new FusionEngine();
        }
        return FusionEngine.instance;
    }

    public subscribe(callback: SpeedUpdateCallback): () => void {
        this.speedListeners.add(callback);
        if (this.speedListeners.size === 1) {
            this.start();
        }
        return () => {
            this.speedListeners.delete(callback);
            if (this.speedListeners.size === 0) {
                this.stop();
            }
        };
    }

    public subscribeCalibration(callback: CalibrationCallback): () => void {
        this.calibrationListeners.add(callback);
        return () => {
            this.calibrationListeners.delete(callback);
        };
    }

    public setAlgorithm(type: 'fusion' | 'passthrough' | 'time-realigned' | 'median-latency' | 'fixed-lookback' | 'calibration', params?: any) {
        this.algorithm.reset();

        switch (type) {
            case 'passthrough':
                this.algorithm = new PassthroughAlgorithm();
                break;
            case 'time-realigned':
                this.algorithm = new TimeRealignedFusionAlgorithm();
                break;
            case 'median-latency':
                this.algorithm = new MedianLatencyFusionAlgorithm();
                break;
            case 'fixed-lookback':
                this.algorithm = new FixedLookbackFusionAlgorithm();
                break;
            case 'calibration':
                this.algorithm = new CalibrationFusionAlgorithm();
                break;
            case 'fusion':
            default:
                this.algorithm = new InertialFusionAlgorithm();
                break;
        }
        if (params) {
            this.algorithm.setParams(params);
        }
        if (this.lastGear !== null) {
            this.algorithm.setGear(this.lastGear);
        }
        this.notifySpeed(0);
    }

    public setAlgorithmParams(params: any) {
        this.algorithm.setParams(params);
    }

    public setGear(gear: string | null) {
        this.lastGear = gear;
        this.algorithm.setGear(gear);
    }

    public getDebugState() {
        return this.algorithm.getDebugState();
    }

    private start() {
        if (this.timer) return;

        // Start Timer
        this.lastUpdateTime = Date.now();
        this.timer = setInterval(this.tick, 20); // 50Hz

        // Start Sensors
        this.startSensors();
    }

    private stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.stopSensors();
    }

    private startSensors() {
        if (this.motionSubscription) return;

        DeviceMotion.requestPermissionsAsync().then(({ status }) => {
            if (status === 'granted') {
                this.motionSubscription = DeviceMotion.addListener((event) => {
                    if (event.acceleration) {
                        this.handleMotionUpdate(event.acceleration);
                    }
                });
            }
        });
    }

    private stopSensors() {
        if (this.motionSubscription) {
            this.motionSubscription.remove();
            this.motionSubscription = null;
        }
    }

    public resetCalibration() {
        this.algorithm.reset();
        if (this.lastGear !== null) {
            this.algorithm.setGear(this.lastGear);
        }
        this.notifyCalibration(false);
    }

    private handleMotionUpdate(accel: Vector3) {
        this.algorithm.pushMotion(accel, Date.now());
    }

    public addBleMeasurement(speed: number, latencyMs?: number) {
        const now = Date.now();
        const latency = latencyMs ?? 0;
        this.algorithm.pushBle(speed, now, latency);
    }

    private tick = () => {
        const now = Date.now();
        const dt = (now - this.lastUpdateTime) / 1000;
        this.lastUpdateTime = now;

        const newSpeed = this.algorithm.update(dt);
        this.notifySpeed(newSpeed);
        this.notifyCalibration(this.algorithm.getDebugState().isCalibrated);
    };

    private notifySpeed(speed: number) {
        for (const listener of this.speedListeners) {
            listener(speed);
        }
    }

    private notifyCalibration(isCalibrated: boolean) {
        for (const listener of this.calibrationListeners) {
            listener(isCalibrated);
        }
    }
}
