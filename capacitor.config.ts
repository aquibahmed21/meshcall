import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.meshcall.app',
  appName: 'MeshCall',
  webDir: 'dist',
  android: { allowMixedContent: false },
};

export default config;
