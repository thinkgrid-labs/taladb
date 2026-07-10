// Stub used by the react-native tsup build. @taladb/node is a native Node.js
// addon and is never called on React Native (detectPlatform() → 'react-native').
// This file exists so Metro never sees the "@taladb/node" specifier.
export const TalaDBNode = null;
