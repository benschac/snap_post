const { getDefaultConfig } = require('expo/metro-config');
const { withThreadedRuntime } = require('@react-native-runtimes/core/metro');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('pte', 'bin');

module.exports = withThreadedRuntime(config, {
  roots: ['src'],
  generatedDir: '.threaded-runtime',
  generatedEntry: 'entry.js',
});
