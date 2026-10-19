let loading: Promise<void> | null = null;

export const loadCubismCore = async (source: string): Promise<void> => {
  const url = new URL(source);
  if (url.protocol !== 'deskpet:' || url.hostname !== 'managed' || url.pathname !== '/core/live2dcubismcore.min.js') {
    throw new Error('Cubism Core must load from the validated managed protocol location.');
  }
  if ('Live2DCubismCore' in window) return;
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url.toString();
    script.async = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Validated Cubism Core failed to load.')), { once: true });
    document.head.append(script);
  });
  await loading;
  if (!('Live2DCubismCore' in window)) throw new Error('Cubism Core did not expose its expected runtime.');
};
