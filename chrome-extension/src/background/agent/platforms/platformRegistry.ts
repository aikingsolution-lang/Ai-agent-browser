// chrome-extension/src/background/agent/platforms/platformRegistry.ts
import type { IPlatformAdapter, SupportedPlatform } from './types';

export class PlatformRegistry {
  private static instance: PlatformRegistry;
  private adapters: Map<SupportedPlatform, IPlatformAdapter> = new Map();

  private constructor() {}

  public static getInstance(): PlatformRegistry {
    if (!PlatformRegistry.instance) {
      PlatformRegistry.instance = new PlatformRegistry();
    }
    return PlatformRegistry.instance;
  }

  public register(adapter: IPlatformAdapter): void {
    this.adapters.set(adapter.platformId, adapter);
  }

  public getAdapter(platformId: SupportedPlatform): IPlatformAdapter {
    const adapter = this.adapters.get(platformId);
    if (!adapter) {
      throw new Error(`Platform adapter not registered for: ${platformId}`);
    }
    return adapter;
  }

  public detectPlatformFromUrl(url: string): IPlatformAdapter | null {
    if (!url) return null;
    const lowerUrl = url.toLowerCase();
    for (const adapter of this.adapters.values()) {
      if (adapter.isMatchingUrl(lowerUrl)) {
        return adapter;
      }
    }
    return null;
  }

  public getAllAdapters(): IPlatformAdapter[] {
    return Array.from(this.adapters.values());
  }

  public isSupported(platformId: string): platformId is SupportedPlatform {
    return this.adapters.has(platformId as SupportedPlatform);
  }
}

export const platformRegistry = PlatformRegistry.getInstance();
