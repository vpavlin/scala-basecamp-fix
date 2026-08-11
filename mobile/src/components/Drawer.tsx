// Left slide-in drawer. Backdrop dismisses; Android hardware back closes it
// (handled by the parent via BackHandler). Animated translateX from the left.
import React, { useEffect, useRef } from "react";
import { Animated, BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";

export function Drawer({ open, onClose, children }: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  const panelW = Math.min(320, width * 0.82);
  const tx = useRef(new Animated.Value(-panelW)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(tx, { toValue: open ? 0 : -panelW, duration: 220, useNativeDriver: true }).start();
    Animated.timing(fade, { toValue: open ? 1 : 0, duration: 220, useNativeDriver: true }).start();
  }, [open, panelW, tx, fade]);

  // Android hardware back closes the drawer instead of exiting the app.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: fade }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[s.panel, { width: panelW, transform: [{ translateX: tx }] }]}>
        {children}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.5)" },
  panel: { position: "absolute", top: 0, bottom: 0, left: 0, backgroundColor: "#181825", borderRightWidth: 1, borderRightColor: "#313244" },
});
