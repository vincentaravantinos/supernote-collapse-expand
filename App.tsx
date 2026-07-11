/**
 * Collapse / Expand — plugin view
 *
 * Shown while a slow operation runs (showPluginView called by an action).
 * Static "Working…" card — no spinner (e-ink). The backdrop is transparent
 * so the page stays visible around the card.
 *
 * @format
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

function App(): React.JSX.Element {
  return (
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.glyph}>⊕</Text>
        <Text style={styles.title}>Collapse / Expand</Text>
        <Text style={styles.sub}>Working…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  card: {
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#000000',
    backgroundColor: '#ffffff',
    minWidth: 300,
  },
  glyph: {fontSize: 28, color: '#000000'},
  title: {fontSize: 18, fontWeight: '700', color: '#000000', marginBottom: 12},
  sub: {fontSize: 15, color: '#000000'},
});

export default App;
