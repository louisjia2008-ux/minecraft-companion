declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const OVERLAY_WINDOW_WEBPACK_ENTRY: string;
declare const OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

declare module '*.css';
declare module 'electron-squirrel-startup' {
  const started: boolean;
  export default started;
}
