{
  description = "scala engine + sync CORE module (delivery via the shared logos-transport).";
  inputs = {
    # scala routes sync through the loam_core FACADE (not delivery_module directly) — ADR 0015.
    # Released tooling baseline (module-builder 0.2.6); loam_core pulls delivery + ble_mesh.
    loam_core.url = "github:vpavlin/loam-basecamp?dir=core";
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.2.6";
    loam_core.inputs.logos-module-builder.follows = "logos-module-builder";
  };
  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
