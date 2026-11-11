const path = require("path");

// Packages that the OpenLens host already provides. They must NOT be bundled,
// otherwise React hooks break with "Invalid hook call" (two React copies).
const rendererExternals = {
  react: "var global.React",
  "react-dom": "var global.ReactDOM",
  "react-router": "var global.ReactRouter",
  "react-router-dom": "var global.ReactRouterDom",
  mobx: "var global.Mobx",
  "mobx-react": "var global.MobxReact",
};

// The host does NOT resolve `@k8slens/extensions` as a module from the
// extension folder (that fails with "Cannot find module"). OpenLens/Lens/
// Freelens 1 expose the API as the global `LensExtensions` instead.
const hostExternals = {
  "@k8slens/extensions": "var global.LensExtensions",
};

const tsRule = {
  test: /\.tsx?$/,
  exclude: /node_modules/,
  use: [
    {
      loader: "ts-loader",
      options: {
        configFile: path.resolve(__dirname, "tsconfig.json"),
        // Lens ships its own type surface; transpile only keeps builds fast and
        // avoids failing on host type-level differences across OpenLens builds.
        transpileOnly: true,
      },
    },
  ],
};

const base = {
  mode: "production",
  devtool: "source-map",
  module: { rules: [tsRule] },
  resolve: { extensions: [".js", ".ts", ".tsx", ".json"] },
  output: {
    path: path.resolve(__dirname, "dist"),
    libraryTarget: "commonjs2",
  },
  performance: { hints: false },
};

module.exports = [
  {
    ...base,
    name: "main",
    target: "electron-main",
    entry: path.resolve(__dirname, "main.ts"),
    output: { ...base.output, filename: "main.js" },
    // our own code (including tar helpers) is bundled; `electron` stays external via the target
    externals: hostExternals,
  },
  {
    ...base,
    name: "renderer",
    target: "electron-renderer",
    entry: path.resolve(__dirname, "renderer.tsx"),
    output: { ...base.output, filename: "renderer.js" },
    externals: { ...rendererExternals, ...hostExternals },
  },
];
