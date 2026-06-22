module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Reanimated 4 moved its Babel plugin into react-native-worklets.
      // Must be listed last.
      'react-native-worklets/plugin',
    ],
  };
};
