# Vendored Asset Licenses

## 3D Models (`public/assets/models/*.gltf`)

- **License:** CC0 (public domain)
- **Creator:** Kenney (kenney.nl)
- **Source:** Fetched from the [pmndrs/market-assets](https://github.com/pmndrs/market-assets)
  GitHub repository (`files/models/<name>/model.gltf`), which mirrors
  Kenney's CC0 asset packs as single-file glTF models with embedded
  base64 data-URI buffers.

Included models: `sedan`, `suv`, `suv-luxury`, `hatchback`, `taxi`, `van`, `tree-big`, `tree-small`, `low-poly-tree`, `formation-stone`, `formation-rock`, `formation-large-stone`, `bench`, `table`, `male`, `skater-male`, `skater-female`, `survivor-male`, `survivor-female`.

## HDRI (`public/assets/hdri/kiara_1_dawn_1k.hdr`)

- **License:** CC0 (public domain)
- **Creator:** Poly Haven (polyhaven.com)
- **Source:** Fetched from the [pmndrs/market-assets](https://github.com/pmndrs/market-assets)
  GitHub repository (`files/hdris/kiara/kiara_1_dawn_1k.hdr`), which mirrors Poly Haven's CC0
  HDRI library.

## Fetch script

These files are vendored (not fetched at build time) via
`scripts/fetch-assets.mjs`. Re-run that script to refresh or add assets.
