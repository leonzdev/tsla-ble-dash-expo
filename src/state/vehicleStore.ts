import { create } from 'zustand';
import { VehicleStateResult } from '@lib/session';

interface VehicleStateStore {
  vin: string | null;
  keyLoaded: boolean;
  driveState: VehicleStateResult | null;
  autoRefreshActive: boolean;
  lastLatencyMs: number | null;
  setVin(vin: string | null): void;
  setKeyLoaded(hasKey: boolean): void;
  setDriveState(result: VehicleStateResult | null): void;
  setAutoRefreshActive(active: boolean): void;
  setLastLatency(latency: number | null): void;
  toggleAutoRefresh(): void;
  fusionDebugEnabled: boolean;
  slopeCorrectionEnabled: boolean;
  fusionAlgoParams: Record<string, any>;
  currentFusionAlgo: 'fusion' | 'passthrough' | 'time-realigned' | 'median-latency' | 'fixed-lookback' | 'calibration';
  setFusionDebugEnabled(enabled: boolean): void;
  setSlopeCorrectionEnabled(enabled: boolean): void;
  setFusionAlgo(algo: 'fusion' | 'passthrough' | 'time-realigned' | 'median-latency' | 'fixed-lookback' | 'calibration'): void;
  setAlgoParam(algo: string, key: string, value: any): void;
}

export const useVehicleStore = create<VehicleStateStore>((set, get) => ({
  vin: null,
  keyLoaded: false,
  driveState: null,
  autoRefreshActive: false,
  lastLatencyMs: null,
  setVin: (vin) => set({ vin }),
  setKeyLoaded: (keyLoaded) => set({ keyLoaded }),
  setDriveState: (driveState) => set({ driveState }),
  setAutoRefreshActive: (autoRefreshActive) => set({ autoRefreshActive }),
  setLastLatency: (lastLatencyMs) => set({ lastLatencyMs }),
  toggleAutoRefresh: () => {
    const current = get().autoRefreshActive;
    set({ autoRefreshActive: !current });
  },
  fusionDebugEnabled: false,
  slopeCorrectionEnabled: false,
  fusionAlgoParams: {
    'fixed-lookback': { lookbackMs: 400 },
  },
  currentFusionAlgo: 'fusion',
  setFusionDebugEnabled: (enabled) => set({ fusionDebugEnabled: enabled }),
  setSlopeCorrectionEnabled: (enabled) => set({ slopeCorrectionEnabled: enabled }),
  setFusionAlgo: (algo) => set({ currentFusionAlgo: algo }),
  setAlgoParam: (algo, key, value) => set((state) => ({
    fusionAlgoParams: {
      ...state.fusionAlgoParams,
      [algo]: {
        ...(state.fusionAlgoParams[algo] || {}),
        [key]: value
      }
    }
  })),
}));
