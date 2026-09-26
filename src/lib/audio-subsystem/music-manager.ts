export type MusicState = 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'STOPPING' | 'ERROR';

export class MusicManager {
  private static instance: MusicManager;
  private state: MusicState = 'IDLE';
  private currentAudio: HTMLAudioElement | null = null;
  private currentTrackId: string | null = null;

  private constructor() {}

  static getInstance(): MusicManager {
    if (!MusicManager.instance) {
      MusicManager.instance = new MusicManager();
    }
    return MusicManager.instance;
  }

  getState(): MusicState {
    return this.state;
  }

  getCurrentTrackId(): string | null {
    return this.currentTrackId;
  }

  stop() {
    this.state = 'STOPPING';
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        URL.revokeObjectURL(this.currentAudio.src);
      } catch {}
      this.currentAudio = null;
    }
    this.currentTrackId = null;
    this.state = 'IDLE';
  }

  async play(blob: Blob, name: string, trackId: string): Promise<void> {
    this.stop();
    this.state = 'LOADING';
    this.currentTrackId = trackId;
    const url = URL.createObjectURL(blob);
    this.currentAudio = new Audio(url);
    this.currentAudio.onended = () => this.stop();
    try {
      await this.currentAudio.play();
      this.state = 'PLAYING';
    } catch {
      this.state = 'ERROR';
    }
  }
}
