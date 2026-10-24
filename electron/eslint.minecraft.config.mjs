// Imported code keeps its original style; unresolved names must still fail CI.
import globals from 'globals';

export default [{
  files: ['minecraft-runtime/vendor/server/**/*.js'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
    globals: globals.node,
  },
  rules: { 'no-undef': 'error' },
}];
