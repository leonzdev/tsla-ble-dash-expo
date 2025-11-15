import { create } from 'zustand';
import { VehicleStateResult } from '@lib/session';

interface VehicleStateStore {
  vin: string | null;
  keyLoaded: boolean;
  driveState: VehicleStateResult | null;
  autoRefreshActive: boolean;
  setVin(vin: string | null): void;
  setKeyLoaded(hasKey: boolean): void;
  setDriveState(result: VehicleStateResult | null): void;
  setAutoRefreshActive(active: boolean): void;
  toggleAutoRefresh(): void;
}

export const useVehicleStore = create<VehicleStateStore>((set, get) => ({
  vin: null,
  keyLoaded: false,
  driveState: null,
  autoRefreshActive: false,
  setVin: (vin) => set({ vin }),
  setKeyLoaded: (keyLoaded) => set({ keyLoaded }),
  setDriveState: (driveState) => set({ driveState }),
  setAutoRefreshActive: (autoRefreshActive) => set({ autoRefreshActive }),
  toggleAutoRefresh: () => {
    const current = get().autoRefreshActive;
    set({ autoRefreshActive: !current });
  },
}));
