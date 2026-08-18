// loam-keycard — reusable React-Native UI for the custody flow: the implicit-unlock PIN gate, the
// "hold your card" tap overlay, and the enrol modal. Generic by injection: each takes a `ctrl`
// (typically thin wrappers over createKeycardSession) and an optional `theme`. Vendor alongside
// keycard.ts/session.ts, or import from the package.
import React, { useEffect, useState } from "react";
import { Modal, View, Text, Pressable, TextInput, StyleSheet } from "react-native";

/** What the UI drives — a session's controls (setPinProvider/onState/enroll) + the driver's abort. */
export interface KeycardUIController {
  setPinProvider(fn: (() => Promise<string | null>) | null): void;
  onState(cb: (s: "idle" | "tap") => void): () => void;
  abort(): void;
  enroll(pin: string, pairing: string): Promise<{ address: string }>;
}
export interface KeycardTheme {
  overlay: string; card: string; border: string; text: string; sub: string; accent: string; field: string; cancelBg: string; onAccent: string;
}
export const defaultKeycardTheme: KeycardTheme = {
  overlay: "rgba(0,0,0,0.7)", card: "#1e1e2e", border: "#89b4fa", text: "#cdd6f4", sub: "#9399b2",
  accent: "#89b4fa", field: "#2a2a3c", cancelBg: "#45475a", onAccent: "#1e1e2e",
};

// Implicit-unlock PIN prompt: registers a pinProvider; when a locked sign needs a PIN, it opens.
export function KeycardPinGate({ ctrl, theme = defaultKeycardTheme }: { ctrl: KeycardUIController; theme?: KeycardTheme }) {
  const [req, setReq] = useState<{ resolve: (p: string | null) => void } | null>(null);
  const [pin, setPin] = useState("");
  useEffect(() => {
    ctrl.setPinProvider(() => new Promise<string | null>((resolve) => { setPin(""); setReq({ resolve }); }));
    return () => ctrl.setPinProvider(null);
  }, [ctrl]);
  const submit = () => { const r = req; setReq(null); r?.resolve(pin.trim() || null); };
  const cancel = () => { const r = req; setReq(null); r?.resolve(null); };
  const s = styles(theme);
  return (
    <Modal visible={!!req} transparent animationType="fade" onRequestClose={cancel}>
      <View style={s.overlay}><View style={s.card}>
        <Text style={s.big}>🔑</Text><Text style={s.title}>Enter your Keycard PIN</Text>
        <TextInput style={s.pinIn} value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry autoFocus placeholder="••••••" placeholderTextColor={theme.sub} onSubmitEditing={submit} />
        <View style={s.row}><Pressable style={s.cancel} onPress={cancel}><Text style={s.cancelT}>Cancel</Text></Pressable><Pressable style={s.ok} onPress={submit}><Text style={s.okT}>Unlock</Text></Pressable></View>
      </View></View>
    </Modal>
  );
}

// "Hold your card" overlay — visible while a tap is in flight; Cancel aborts it.
export function KeycardTapOverlay({ ctrl, theme = defaultKeycardTheme }: { ctrl: KeycardUIController; theme?: KeycardTheme }) {
  const [tap, setTap] = useState(false);
  useEffect(() => ctrl.onState((x) => setTap(x === "tap")), [ctrl]);
  const cancel = () => { try { ctrl.abort(); } catch { /* */ } setTap(false); };
  const s = styles(theme);
  return (
    <Modal visible={tap} transparent animationType="fade" onRequestClose={cancel}>
      <View style={s.overlay}><View style={s.card}>
        <Text style={s.big}>🔑</Text><Text style={s.title}>Hold your Keycard to the phone…</Text>
        <Pressable style={s.cancel} onPress={cancel}><Text style={s.cancelT}>Cancel</Text></Pressable>
      </View></View>
    </Modal>
  );
}

// Enrol modal: PIN prominent, pairing under Advanced. Calls ctrl.enroll then onResult(address).
export function KeycardEnrollModal({ ctrl, visible, onClose, onResult, onError, defaultPairing = "KeycardDefaultPairing", theme = defaultKeycardTheme }: {
  ctrl: KeycardUIController; visible: boolean; onClose: () => void;
  onResult?: (address: string) => void; onError?: (e: any) => void; defaultPairing?: string; theme?: KeycardTheme;
}) {
  const [pin, setPin] = useState("");
  const [pairing, setPairing] = useState(defaultPairing);
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setPin(""); setAdv(false); setPairing(defaultPairing); } }, [visible, defaultPairing]);
  const go = async () => {
    setBusy(true);
    try { const r = await ctrl.enroll(pin.trim(), pairing.trim()); onResult?.(r.address); onClose(); }
    catch (e) { onError?.(e); }
    finally { setBusy(false); }
  };
  const s = styles(theme);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.overlay}><View style={s.card}>
        <Text style={s.big}>🔑</Text><Text style={s.title}>Set up your Keycard</Text>
        <Text style={s.sub}>Enter your PIN, then hold the card to the phone. This reads its key and makes it your identity.</Text>
        <TextInput style={s.pinIn} value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry autoFocus placeholder="••••••" placeholderTextColor={theme.sub} onSubmitEditing={() => !busy && go()} />
        {adv
          ? <TextInput style={s.pairIn} placeholder="pairing password" placeholderTextColor={theme.sub} value={pairing} onChangeText={setPairing} autoCapitalize="none" autoCorrect={false} />
          : <Pressable onPress={() => setAdv(true)} hitSlop={8}><Text style={s.advT}>Advanced · pairing password</Text></Pressable>}
        <View style={s.row}><Pressable style={s.cancel} onPress={onClose}><Text style={s.cancelT}>Cancel</Text></Pressable><Pressable style={[s.ok, busy && { opacity: 0.5 }]} disabled={busy} onPress={go}><Text style={s.okT}>Enroll (tap)</Text></Pressable></View>
      </View></View>
    </Modal>
  );
}

const styles = (t: KeycardTheme) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: t.overlay, alignItems: "center", justifyContent: "center", padding: 24 },
  card: { backgroundColor: t.card, borderRadius: 16, padding: 30, alignItems: "center", borderWidth: 1, borderColor: t.border, minWidth: 260 },
  big: { fontSize: 40 },
  title: { color: t.text, fontSize: 16, marginTop: 12, textAlign: "center" },
  sub: { color: t.sub, fontSize: 12.5, marginTop: 8, textAlign: "center", lineHeight: 17, maxWidth: 240 },
  pinIn: { backgroundColor: t.field, color: t.text, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12, marginTop: 16, width: 200, textAlign: "center", fontSize: 20, letterSpacing: 4 },
  pairIn: { backgroundColor: t.field, color: t.text, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, marginTop: 10, width: 220 },
  advT: { color: t.accent, fontSize: 12.5, marginTop: 12, textDecorationLine: "underline" },
  row: { flexDirection: "row", gap: 10, marginTop: 8 },
  cancel: { paddingVertical: 10, paddingHorizontal: 24, borderRadius: 6, backgroundColor: t.cancelBg, marginTop: 8 },
  cancelT: { color: t.text, fontWeight: "600" },
  ok: { paddingVertical: 10, paddingHorizontal: 28, borderRadius: 6, backgroundColor: t.accent, marginTop: 8 },
  okT: { color: t.onAccent, fontWeight: "700" },
});
