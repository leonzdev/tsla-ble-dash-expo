export function normalizeGear(raw: string | null | undefined): 'P' | 'R' | 'N' | 'D' | null {
    if (!raw) return null;
    const value = String(raw).trim().toUpperCase();
    if (value.startsWith('R')) return 'R';
    if (value.startsWith('D')) return 'D';
    if (value.startsWith('N')) return 'N';
    if (value.startsWith('P')) return 'P';
    return null;
}
