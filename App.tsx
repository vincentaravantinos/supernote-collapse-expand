/**
 * Collapse / Expand — plugin view
 *
 * Shown while a slow operation runs (showPluginView called by an action).
 * Static "Working…" card — no spinner (e-ink). The backdrop is transparent
 * so the page stays visible around the card. After CANCEL_DELAY_MS with the
 * card still up, a Cancel button appears (see BUGS/B-008.md: an operation
 * whose foreground app switched away mid-flight can leave this card stuck
 * with nothing left running to close it).
 *
 * @format
 */

import React, {useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {getGeneration} from './src/logic/workingViewStore';
import {cancelStuckOperation} from './src/logic/busy';

const CANCEL_DELAY_MS = 7000;
const POLL_MS = 300;

function App(): React.JSX.Element {
  const [showCancel, setShowCancel] = useState(false);
  const lastGenRef = useRef(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const poll = setInterval(() => {
      const gen = getGeneration();
      if (gen !== lastGenRef.current) {
        lastGenRef.current = gen;
        setShowCancel(false);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setShowCancel(true), CANCEL_DELAY_MS);
      }
    }, POLL_MS);
    return () => {
      clearInterval(poll);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.glyph}>⊕</Text>
        <Text style={styles.title}>Collapse / Expand</Text>
        <Text style={styles.sub}>Working…</Text>
        {showCancel && (
          <>
            <Text style={styles.notice}>
              This is taking longer than usual — could just be a lot to
              process, or something may have gone wrong.
            </Text>
            <Text style={styles.warning}>
              This will interrupt the operation partway through — you may see
              duplicated content that you'll need to clean up manually.
              Nothing will be lost.
            </Text>
            <TouchableOpacity style={styles.cancelButton} onPress={cancelStuckOperation}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </>
        )}
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
    maxWidth: 420,
  },
  glyph: {fontSize: 28, color: '#000000'},
  title: {fontSize: 18, fontWeight: '700', color: '#000000', marginBottom: 12},
  sub: {fontSize: 15, color: '#000000'},
  notice: {fontSize: 14, fontWeight: '600', color: '#000000', marginTop: 16},
  warning: {fontSize: 13, color: '#000000', marginTop: 8},
  cancelButton: {
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#000000',
    alignItems: 'center',
  },
  cancelText: {fontSize: 15, fontWeight: '700', color: '#000000'},
});

export default App;
