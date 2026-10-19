// Imported code keeps its original style; unresolved names must still fail CI.
export default [{
  files: ['minecraft-runtime/vendor/server/**/*.js'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
    globals: Object.fromEntries([
      'require', 'module', 'process', '__dirname', 'Buffer', 'console',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'queueMicrotask', 'AbortController', 'URL',
    ].map((name) => [name, 'readonly'])),
  },
  rules: { 'no-undef': 'error' },
}];
