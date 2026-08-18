// loam-keycard — multiple authoring identities + per-container binding (the "loam-identity" helper).
//
// An IDENTITY is a keypair that AUTHORS events; a CONTAINER (a scala calendar, a kym budget, a qaku
// room…) is bound to one. Events are self-describing (pub/sig/dev), so this is purely app-level —
// which key signs YOUR events for a given container — with NO fold/wire/desktop change.
//
// Kinds: "device" (built-in software key, always present) · "soft" (extra named software keys, to
// compartmentalise without a card) · "keycard" (the enrolled Status Keycard, hardware, present iff
// enrolled). A container with no explicit binding falls back to the DEFAULT identity (itself
// keycard-if-enrolled-else-device), so pre-feature containers keep today's behaviour.
//
// Generic by dependency injection: the app supplies its own software-key seam (its event signing +
// key derivation) and an optional keycard seam (createKeycardSession's wrappers). Storage keys are
// `${prefix}.identities.{registry,bindings,default}` + soft privs `${prefix}-soft-<id>` — pass the
// app's existing prefix to keep prior data.
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type IdKind = "device" | "soft" | "keycard";
export type IdentityMeta = { id: string; kind: IdKind; label: string; address: string; pubHex: string };
export interface SoftKey { priv: Uint8Array; address: string; pubHex: string }

/** The app's software-key operations (device + named soft keys) — its own event signing seam. */
export interface SoftKeySeam {
  getDeviceKey(): Promise<SoftKey>;
  keyFromPriv(priv: Uint8Array): SoftKey;
  freshPriv(): Uint8Array;
  signEvent(key: SoftKey, ev: any): any;
  hex(b: Uint8Array): string;
  fromHex(s: string): Uint8Array;
}
/** The Keycard identity ops — typically a thin wrap of createKeycardSession(). Optional. */
export interface KeycardIdentitySeam {
  loadEnrollment(): Promise<unknown>;
  isEnrolled(): boolean;
  address(): string | null;
  pubHex(): string | null;
  signEvent(ev: any): Promise<any>;
}
export interface IdentityRegistryOpts {
  storagePrefix: string; // e.g. "scala" → scala.identities.registry, scala-soft-<id>
  soft: SoftKeySeam;
  keycard?: KeycardIdentitySeam;
  deviceLabel?: string;
  keycardLabel?: string;
}

export interface IdentityRegistry {
  listIdentities(): Promise<IdentityMeta[]>;
  addSoftIdentity(label: string): Promise<IdentityMeta>;
  renameSoftIdentity(id: string, label: string): Promise<void>;
  removeSoftIdentity(id: string): Promise<void>;
  getDefaultIdentityId(): Promise<string>;
  setDefaultIdentityId(id: string): Promise<void>;
  bindingFor(containerId: string): Promise<string | null>;
  bindContainer(containerId: string, identityId: string): Promise<void>;
  identityForContainer(containerId: string): Promise<IdentityMeta>;
  /** Sign one event with the container's identity (keycard → NFC tap; soft/device → local). */
  authorEvent(containerId: string, ev: any): Promise<any>;
  /** Address of the default identity (for the clock/senderId; per-event author is set by authorEvent). */
  defaultAddress(): Promise<string>;
}

export function createIdentityRegistry(opts: IdentityRegistryOpts): IdentityRegistry {
  const { soft, keycard } = opts;
  const REG_KEY = opts.storagePrefix + ".identities.registry";
  const BIND_KEY = opts.storagePrefix + ".identities.bindings";
  const DEFAULT_KEY = opts.storagePrefix + ".identities.default";
  const softPrivKey = (id: string) => opts.storagePrefix + "-soft-" + id;
  const deviceLabel = opts.deviceLabel ?? "This device";
  const keycardLabel = opts.keycardLabel ?? "Keycard";

  const readJson = async <T>(k: string, d: T): Promise<T> => { try { const s = await AsyncStorage.getItem(k); return s ? JSON.parse(s) : d; } catch { return d; } };
  const writeJson = async (k: string, v: any): Promise<void> => { try { await AsyncStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };

  const deviceMeta = async (): Promise<IdentityMeta> => {
    const k = await soft.getDeviceKey();
    return { id: "device", kind: "device", label: deviceLabel, address: k.address, pubHex: k.pubHex };
  };
  const keycardMeta = async (): Promise<IdentityMeta | null> => {
    if (!keycard) return null;
    await keycard.loadEnrollment();
    if (!keycard.isEnrolled()) return null;
    return { id: "keycard", kind: "keycard", label: keycardLabel, address: keycard.address()!, pubHex: keycard.pubHex() || "" };
  };
  const softMetas = async (): Promise<IdentityMeta[]> => {
    const reg = await readJson<{ id: string; label: string }[]>(REG_KEY, []);
    const out: IdentityMeta[] = [];
    for (const r of reg) {
      const hp = await SecureStore.getItemAsync(softPrivKey(r.id));
      if (!hp) continue;
      const k = soft.keyFromPriv(soft.fromHex(hp));
      out.push({ id: r.id, kind: "soft", label: r.label, address: k.address, pubHex: k.pubHex });
    }
    return out;
  };

  const listIdentities = async (): Promise<IdentityMeta[]> => {
    const out = [await deviceMeta(), ...(await softMetas())];
    const kc = await keycardMeta(); if (kc) out.push(kc);
    return out;
  };
  const getDefaultIdentityId = async (): Promise<string> => {
    const explicit = await AsyncStorage.getItem(DEFAULT_KEY);
    if (explicit) { const all = await listIdentities(); if (all.some((m) => m.id === explicit)) return explicit; }
    return (await keycardMeta()) ? "keycard" : "device";
  };
  const bindingFor = async (containerId: string): Promise<string | null> => {
    const b = await readJson<Record<string, string>>(BIND_KEY, {}); return b[containerId] ?? null;
  };
  const identityForContainer = async (containerId: string): Promise<IdentityMeta> => {
    const wantId = (await bindingFor(containerId)) ?? (await getDefaultIdentityId());
    const all = await listIdentities();
    return all.find((m) => m.id === wantId) ?? (await deviceMeta());
  };

  return {
    listIdentities,
    getDefaultIdentityId,
    bindingFor,
    identityForContainer,
    async addSoftIdentity(label) {
      const id = "soft-" + Crypto.randomUUID();
      const priv = soft.freshPriv();
      await SecureStore.setItemAsync(softPrivKey(id), soft.hex(priv));
      const reg = await readJson<{ id: string; label: string }[]>(REG_KEY, []);
      reg.push({ id, label: label || "Identity " + (reg.length + 1) });
      await writeJson(REG_KEY, reg);
      const k = soft.keyFromPriv(priv);
      return { id, kind: "soft", label, address: k.address, pubHex: k.pubHex };
    },
    async renameSoftIdentity(id, label) {
      const reg = await readJson<{ id: string; label: string }[]>(REG_KEY, []);
      const r = reg.find((x) => x.id === id); if (r) { r.label = label; await writeJson(REG_KEY, reg); }
    },
    async removeSoftIdentity(id) {
      const reg = (await readJson<{ id: string; label: string }[]>(REG_KEY, [])).filter((x) => x.id !== id);
      await writeJson(REG_KEY, reg);
      try { await SecureStore.deleteItemAsync(softPrivKey(id)); } catch { /* */ }
      const b = await readJson<Record<string, string>>(BIND_KEY, {});
      let changed = false; for (const k of Object.keys(b)) if (b[k] === id) { delete b[k]; changed = true; }
      if (changed) await writeJson(BIND_KEY, b);
    },
    async setDefaultIdentityId(id) { await AsyncStorage.setItem(DEFAULT_KEY, id); },
    async bindContainer(containerId, identityId) {
      const b = await readJson<Record<string, string>>(BIND_KEY, {}); b[containerId] = identityId; await writeJson(BIND_KEY, b);
    },
    async authorEvent(containerId, ev) {
      const meta = await identityForContainer(containerId);
      if (meta.kind === "keycard") { if (!keycard) throw new Error("keycard identity but no keycard seam"); return keycard.signEvent(ev); }
      const priv = meta.kind === "device"
        ? (await soft.getDeviceKey()).priv
        : soft.fromHex((await SecureStore.getItemAsync(softPrivKey(meta.id))) || "");
      if (priv.length !== 32) throw new Error("identity key unavailable");
      return soft.signEvent(soft.keyFromPriv(priv), ev);
    },
    async defaultAddress() {
      const wantId = await getDefaultIdentityId();
      const all = await listIdentities();
      return (all.find((m) => m.id === wantId) ?? (await deviceMeta())).address;
    },
  };
}
