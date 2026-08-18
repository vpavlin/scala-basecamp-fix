// Node stub for the two Expo modules identity.ts imports (RN-only). The fold/verify/sign path
// never calls these — they only need to RESOLVE so the module graph loads under node.
export const getRandomBytes = (n) => new Uint8Array(n);
export const randomUUID = () => "00000000-0000-4000-8000-000000000000";
export const getItemAsync = async () => null;
export const setItemAsync = async () => {};
export const deleteItemAsync = async () => {};
export default {};
