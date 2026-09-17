export type MusicState = 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'STOPPING' | 'ERROR';

export class MusicManager {
  private static instance: MusicManager;
  private state: MusicState = 'IDLE';
  private currentAudio: HTMLAudioElement | null = null;

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

  stop() {
    this.state = 'STOPPING';
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        URL.revokeObjectURL(this.currentAudio.src);
      } catch {}
      this.currentAudio = null;
    }
    this.state = 'IDLE';
  }

  async play(blob: Blob, name: string): Promise<void> {
    this.stop();
    this.state = 'LOADING';
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
