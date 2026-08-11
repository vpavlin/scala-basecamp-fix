// Camera QR scanner — scan a scala:// invite to join a calendar.
import React, { useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions, BarcodeScanningResult } from "expo-camera";

const C = { bg: "#1e1e2e", text: "#cdd6f4", sub: "#9399b2", primary: "#89b4fa" };

export function ScanModal({ visible, onScanned, onClose }: {
  visible: boolean; onScanned: (data: string) => void; onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const done = useState({ v: false })[0]; // guard against duplicate scans

  React.useEffect(() => {
    if (visible) {
      done.v = false;
      if (permission && !permission.granted) requestPermission();
    }
  }, [visible]);

  const handle = (r: BarcodeScanningResult) => {
    if (done.v) return;
    done.v = true;
    onScanned(r.data);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.root}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={handle}
          />
        ) : (
          <View style={s.center}>
            <Text style={s.msg}>Camera permission is needed to scan a QR.</Text>
            <Pressable style={s.btn} onPress={requestPermission}><Text style={s.btnT}>Grant permission</Text></Pressable>
          </View>
        )}
        <View style={s.overlay}>
          <Text style={s.hint}>Point at a Scala invite QR</Text>
          <Pressable style={s.cancel} onPress={onClose}><Text style={s.cancelT}>Cancel</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  msg: { color: C.text, fontSize: 15, textAlign: "center", marginBottom: 16 },
  overlay: { position: "absolute", left: 0, right: 0, bottom: 40, alignItems: "center", paddingHorizontal: 24 },
  hint: { color: "#fff", fontSize: 15, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  cancel: { marginTop: 16, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.6)" },
  cancelT: { color: "#fff", fontSize: 15, fontWeight: "600" },
  btn: { backgroundColor: C.primary, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
  btnT: { color: C.bg, fontWeight: "700" },
});
