/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SCALEDRONE_CHANNEL_ID?: string;
  readonly VITE_STUN_SERVER?: string;
  readonly VITE_TURN_SERVER?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly VITE_DIRECT_P2P_TIMEOUT_MS?: string;
  readonly VITE_HOST_ONLY_WINDOW_MS?: string;
  readonly VITE_ICE_FALLBACK_MODE?: string;
  readonly VITE_RELAY_UPGRADE_PROBE_MS?: string;
  readonly VITE_PUSH_SERVER_URL?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  readonly VITE_LOG_LEVEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
