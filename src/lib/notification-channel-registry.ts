// src/lib/notification-channel-registry.ts

import {
  NotificationChannelProvider,
  NotificationChannelCapabilities,
  PermissionState,
  ChannelAvailabilityReport,
} from './notification-channel';
import { InAppNotificationChannelProvider } from './in-app-channel-provider';
import { BrowserNotificationChannelProvider } from './browser-notification-channel';

export interface ChannelResolutionResult {
  status: 'resolved' | 'unsupported' | 'unavailable';
  provider?: NotificationChannelProvider;
  error?: string;
}

export class NotificationChannelRegistry {
  private channels = new Map<string, NotificationChannelProvider>();
  private autoRegisterDefaults: boolean;
  private defaultsRegistered = false;

  constructor(registerDefaults = true) {
    this.autoRegisterDefaults = registerDefaults;
  }

  private ensureDefaults(): void {
    if (!this.autoRegisterDefaults || this.defaultsRegistered) return;
    this.defaultsRegistered = true;
    this.registerDefaultChannels();
  }

  private registerDefaultChannels(): void {
    this.registerChannel(new InAppNotificationChannelProvider(), { allowOverride: true });
    this.registerChannel(new BrowserNotificationChannelProvider(), { allowOverride: true });
  }

  /**
   * Registers a channel provider. Throws an error on duplicate IDs unless allowOverride is true.
   */
  public registerChannel(
    provider: NotificationChannelProvider,
    options: { allowOverride?: boolean } = {}
  ): void {
    this.ensureDefaults();
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
      throw new Error('A valid NotificationChannelProvider with a non-empty string id is required');
    }

    const channelId = provider.id.trim().toLowerCase();
    if (this.channels.has(channelId) && !options.allowOverride) {
      throw new Error(`Notification channel "${channelId}" is already registered. Use allowOverride: true to overwrite.`);
    }

    this.channels.set(channelId, provider);
  }

  /**
   * Unregisters a channel by ID. Returns true if removed, false if not found.
   */
  public unregisterChannel(channelId: string): boolean {
    this.ensureDefaults();
    if (!channelId || typeof channelId !== 'string') return false;
    return this.channels.delete(channelId.trim().toLowerCase());
  }

  /**
   * Retrieves a registered channel provider by ID.
   */
  public getChannel(channelId: string): NotificationChannelProvider | undefined {
    this.ensureDefaults();
    if (!channelId || typeof channelId !== 'string') return undefined;
    return this.channels.get(channelId.trim().toLowerCase());
  }

  /**
   * Checks whether a channel is registered.
   */
  public hasChannel(channelId: string): boolean {
    this.ensureDefaults();
    if (!channelId || typeof channelId !== 'string') return false;
    return this.channels.has(channelId.trim().toLowerCase());
  }

  /**
   * Lists all registered channel providers.
   */
  public listChannels(): NotificationChannelProvider[] {
    this.ensureDefaults();
    return Array.from(this.channels.values());
  }

  /**
   * Lists all channel providers that report availability in the current environment.
   */
  public async listAvailableChannels(userId?: string): Promise<NotificationChannelProvider[]> {
    this.ensureDefaults();
    const available: NotificationChannelProvider[] = [];
    for (const provider of this.channels.values()) {
      const isAvail = await provider.isAvailable(userId);
      if (isAvail) {
        available.push(provider);
      }
    }
    return available;
  }

  /**
   * Queries whether a specific channel is registered and available.
   */
  public async isChannelAvailable(channelId: string, userId?: string): Promise<boolean> {
    const provider = this.getChannel(channelId);
    if (!provider) return false;
    try {
      return await provider.isAvailable(userId);
    } catch {
      return false;
    }
  }

  /**
   * Returns capabilities for a registered channel, or undefined if unknown.
   */
  public getChannelCapabilities(channelId: string): NotificationChannelCapabilities | undefined {
    const provider = this.getChannel(channelId);
    return provider ? provider.getCapabilities() : undefined;
  }

  /**
   * Returns permission state for a channel. Returns 'unavailable' if channel is unknown.
   */
  public async getChannelPermission(channelId: string, userId?: string): Promise<PermissionState> {
    const provider = this.getChannel(channelId);
    if (!provider) return 'unavailable';
    try {
      return await provider.getPermissionState(userId);
    } catch {
      return 'unavailable';
    }
  }

  /**
   * Returns a comprehensive availability report distinguishing supported, available, permission, and enabled dimensions.
   */
  public async getChannelReport(
    channelId: string,
    userId?: string
  ): Promise<ChannelAvailabilityReport> {
    const provider = this.getChannel(channelId);
    if (!provider) {
      return {
        supported: false,
        available: false,
        permission: 'unavailable',
        enabled: false,
      };
    }

    let isAvail = false;
    let perm: PermissionState = 'unknown';

    try {
      isAvail = await provider.isAvailable(userId);
    } catch {
      isAvail = false;
    }

    try {
      perm = await provider.getPermissionState(userId);
    } catch {
      perm = 'unavailable';
    }

    return {
      supported: true,
      available: isAvail,
      permission: perm,
      enabled: isAvail && (perm === 'granted' || perm === 'not_required'),
    };
  }

  /**
   * Resolves a channel by ID (defaults to 'in_app' if unspecified).
   */
  public async resolveChannel(channelId?: string, userId?: string): Promise<ChannelResolutionResult> {
    this.ensureDefaults();
    const targetId = (channelId || 'in_app').trim().toLowerCase();

    if (!this.channels.has(targetId)) {
      return {
        status: 'unsupported',
        error: `Channel "${targetId}" is unsupported.`,
      };
    }

    const provider = this.channels.get(targetId)!;
    const isAvail = await provider.isAvailable(userId);
    if (!isAvail) {
      return {
        status: 'unavailable',
        provider,
        error: `Channel "${targetId}" is currently unavailable in this environment.`,
      };
    }

    return {
      status: 'resolved',
      provider,
    };
  }

  /**
   * Resets registry. If restoreDefaults is true, re-registers the default in_app channel.
   */
  public reset(restoreDefaults = true): void {
    this.channels.clear();
    this.autoRegisterDefaults = restoreDefaults;
    this.defaultsRegistered = false;
    if (restoreDefaults) {
      this.ensureDefaults();
    }
  }

  /**
   * Completely clears all registered channels.
   */
  public clear(): void {
    this.channels.clear();
    this.defaultsRegistered = true;
  }
}

export const notificationChannelRegistry = new NotificationChannelRegistry();
