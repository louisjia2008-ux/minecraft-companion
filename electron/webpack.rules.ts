import type { RuleSetRule } from 'webpack';

export const rules: RuleSetRule[] = [
  {
    test: /\.tsx?$/,
    exclude: /node_modules/,
    use: {
      loader: 'ts-loader',
      options: {
        transpileOnly: false,
      },
    },
  },
  {
    test: /\.css$/,
    use: ['style-loader', 'css-loader'],
  },
  {
    test: /\.(png|jpe?g|gif|svg|woff2?)$/i,
    type: 'asset/resource',
  },
];
