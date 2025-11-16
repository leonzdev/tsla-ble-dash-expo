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
}));
