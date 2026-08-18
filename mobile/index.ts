import "react-native-get-random-values"; // entropy polyfill for keycard-sdk (Hermes) — must load first
import { registerRootComponent } from "expo";
import App from "./App";
registerRootComponent(App);
