const { isMainRuntime } = require('@react-native-runtimes/core');

if (isMainRuntime()) {
  require('expo-router/entry');
} else {
  require('./.threaded-runtime/entry');
}
