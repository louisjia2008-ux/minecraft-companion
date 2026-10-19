import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';

export const mainConfig: Configuration = {
  entry: {
    index: './src/main/index.ts',
    utility: './src/utility/entry.ts',
  },
  output: {
    filename: '[name].js',
  },
  module: { rules },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
